// Package check looks at a Kubara hub after handover and says, for each
// variant, whether the cluster runs the release ConfigHub approved: its
// Application reads the variant's release, is synced to the latest one, would
// prune nothing, and leaves live Secret values alone. It can record each
// verdict in ConfigHub as an attestation.
package check

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/confighub/kubara-confighub/internal/handover"
	"github.com/confighub/kubara-confighub/internal/plan"
)

// DefaultType is the attestation type a recorded verdict carries.
const DefaultType = "LiveCheck"

const argoNamespace = "argocd"

// Run runs a command and returns its standard output.
type Run func(name string, args ...string) ([]byte, error)

// Options says where to look and whether to record.
type Options struct {
	HubContext string // kubectl context of Kubara's hub; empty is the current one
	Gateway    string
	Record     bool
	Type       string
}

// Result is the verdict on one variant.
type Result struct {
	Space       string
	Cluster     string
	Component   string
	Application string
	Release     int    // the latest published release, 0 when there is none
	Revision    string // what Argo CD last synced
	Health      string
	Problems    []string
	Skipped     string // why the variant was not judged
	Recorded    string // the attestation's ID
}

// Passed reports whether the variant was judged and nothing was wrong.
func (r Result) Passed() bool { return r.Skipped == "" && len(r.Problems) == 0 }

type application struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Source *struct {
			RepoURL string `json:"repoURL"`
		} `json:"source"`
		Sources []struct {
			RepoURL string `json:"repoURL"`
		} `json:"sources"`
		IgnoreDifferences []struct {
			Kind         string   `json:"kind"`
			JSONPointers []string `json:"jsonPointers"`
		} `json:"ignoreDifferences"`
		SyncPolicy struct {
			SyncOptions []string `json:"syncOptions"`
		} `json:"syncPolicy"`
	} `json:"spec"`
	Status struct {
		Sync struct {
			Status   string `json:"status"`
			Revision string `json:"revision"`
		} `json:"sync"`
		Health struct {
			Status string `json:"status"`
		} `json:"health"`
		Resources []struct {
			Kind            string `json:"kind"`
			Namespace       string `json:"namespace"`
			Name            string `json:"name"`
			RequiresPruning bool   `json:"requiresPruning"`
			Hook            bool   `json:"hook"`
		} `json:"resources"`
	} `json:"status"`
}

type release struct {
	Release struct {
		ReleaseNum     int    `json:"ReleaseNum"`
		ManifestDigest string `json:"ManifestDigest"`
		Published      bool   `json:"Published"`
	} `json:"Release"`
}

var recordedID = regexp.MustCompile(`attestation ([0-9a-f-]{36})`)

// Check judges every variant in the plan against what Kubara's hub runs.
func Check(p plan.Plan, run Run, opts Options) ([]Result, error) {
	if opts.Gateway == "" {
		opts.Gateway = handover.DefaultGateway
	}
	if opts.Type == "" {
		opts.Type = DefaultType
	}
	kubectl := func(args ...string) ([]byte, error) {
		if opts.HubContext != "" {
			args = append([]string{"--context", opts.HubContext}, args...)
		}
		return run("kubectl", args...)
	}

	out, err := kubectl("-n", argoNamespace, "get", "applications", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("reading the hub's Applications: %w", err)
	}
	var apps struct{ Items []application }
	if err := json.Unmarshal(out, &apps); err != nil {
		return nil, fmt.Errorf("reading the hub's Applications: %w", err)
	}
	reading := map[string]*application{}
	for i := range apps.Items {
		a := &apps.Items[i]
		if a.Spec.Source != nil {
			reading[a.Spec.Source.RepoURL] = a
		}
	}

	out, err = kubectl("-n", argoNamespace, "get", "applicationsets", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("reading the hub's ApplicationSets: %w", err)
	}
	var sets struct{ Items []json.RawMessage }
	if err := json.Unmarshal(out, &sets); err != nil {
		return nil, fmt.Errorf("reading the hub's ApplicationSets: %w", err)
	}
	delivered := map[string]bool{}
	for _, s := range sets.Items {
		chart, err := handover.ChartOf(s, p.Prefix)
		if err != nil {
			return nil, err
		}
		delivered[chart] = true
	}

	var results []Result
	for _, c := range p.Components {
		for _, v := range c.Variants {
			r := Result{Space: v.Space, Cluster: v.Cluster, Component: c.Name}
			repo := fmt.Sprintf("oci://%s/space/%s", opts.Gateway, v.Space)
			a := reading[repo]
			switch {
			case a == nil && !delivered[c.ChartPath]:
				r.Skipped = "no ApplicationSet delivers it; Kubara's bootstrap keeps it"
			case a == nil:
				r.Problems = append(r.Problems, "no Application reads "+repo+"; run handover.sh")
			default:
				judge(&r, a)
				if err := judgeRelease(&r, a, run); err != nil {
					return results, err
				}
			}
			results = append(results, r)
		}
	}

	if opts.Record {
		for i := range results {
			if err := record(&results[i], run, opts.Type); err != nil {
				return results, err
			}
		}
	}
	return results, nil
}

// judge checks what the Application itself says.
func judge(r *Result, a *application) {
	r.Application = a.Metadata.Name
	r.Revision = a.Status.Sync.Revision
	r.Health = a.Status.Health.Status
	if len(a.Spec.Sources) > 0 {
		r.Problems = append(r.Problems, "it still lists Git sources, which Argo CD reads before the release")
	}
	if a.Status.Sync.Status != "Synced" {
		r.Problems = append(r.Problems, "sync status is "+or(a.Status.Sync.Status, "unknown"))
	}
	var prune []string
	for _, res := range a.Status.Resources {
		// Argo CD flags Helm hooks too, but runs them as hooks and never prunes them.
		if res.RequiresPruning && !res.Hook {
			prune = append(prune, strings.TrimPrefix(res.Kind+"/"+res.Namespace+"/"+res.Name, "/"))
		}
	}
	if len(prune) > 0 {
		sort.Strings(prune)
		r.Problems = append(r.Problems, "Argo CD would delete "+strings.Join(prune, ", "))
	}
	data, stringData := false, false
	for _, d := range a.Spec.IgnoreDifferences {
		if d.Kind != "Secret" {
			continue
		}
		for _, ptr := range d.JSONPointers {
			data = data || ptr == "/data"
			stringData = stringData || ptr == "/stringData"
		}
	}
	respect := false
	for _, o := range a.Spec.SyncPolicy.SyncOptions {
		respect = respect || o == "RespectIgnoreDifferences=true"
	}
	if !data || !stringData || !respect {
		r.Problems = append(r.Problems, "a sync would overwrite live Secret values: it needs ignoreDifferences on Secret /data and /stringData, and RespectIgnoreDifferences=true")
	}
}

// judgeRelease checks that Argo CD runs the latest release ConfigHub published.
func judgeRelease(r *Result, a *application, run Run) error {
	out, err := run("cub", "release", "list", "--space", r.Space, "-o", "json")
	if err != nil {
		return fmt.Errorf("%s: listing releases: %w", r.Space, err)
	}
	var rels []release
	if err := json.Unmarshal(out, &rels); err != nil {
		return fmt.Errorf("%s: listing releases: %w", r.Space, err)
	}
	var latest *release
	for i := range rels {
		if rels[i].Release.Published && (latest == nil || rels[i].Release.ReleaseNum > latest.Release.ReleaseNum) {
			latest = &rels[i]
		}
	}
	if latest == nil {
		r.Problems = append(r.Problems, "ConfigHub has published no release for it")
		return nil
	}
	r.Release = latest.Release.ReleaseNum
	if a.Status.Sync.Revision != latest.Release.ManifestDigest {
		r.Problems = append(r.Problems, fmt.Sprintf("Argo CD runs %s, and the latest release, %d, is %s", short(a.Status.Sync.Revision), r.Release, short(latest.Release.ManifestDigest)))
	}
	return nil
}

// record writes the verdict as an attestation on the released revisions: a
// Pass, or a rejection naming what is wrong.
func record(r *Result, run Run, typ string) error {
	if r.Skipped != "" || r.Release == 0 {
		return nil
	}
	note := "cub kubara check: " + r.Application + " reads and runs release " + fmt.Sprint(r.Release) + ", synced, prunes nothing, keeps Secret values"
	args := []string{"attestation", "create", "--space", r.Space, "--type", typ,
		"--revision", "LastReleasedRevisionNum",
		"--claim", "argocd.argoproj.io/application=" + r.Application,
		"--claim", "argocd.argoproj.io/revision=" + r.Revision}
	if len(r.Problems) > 0 {
		note = "cub kubara check: " + strings.Join(r.Problems, "; ")
		args = append(args, "--reject")
	}
	out, err := run("cub", append(args, "--note", note)...)
	if err != nil {
		return fmt.Errorf("%s: recording the verdict: %w", r.Space, err)
	}
	if m := recordedID.FindSubmatch(out); m != nil {
		r.Recorded = string(m[1])
	}
	return nil
}

func short(digest string) string {
	if d := strings.TrimPrefix(digest, "sha256:"); len(d) > 12 {
		return "sha256:" + d[:12]
	}
	return or(digest, "nothing")
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

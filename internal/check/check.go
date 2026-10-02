// Package check looks at a Kubara hub after handover and says, for each
// variant, whether the cluster runs the release ConfigHub approved: its
// Application reads the variant's release, is synced to the latest one, is
// Healthy, would prune nothing, and leaves live Secret values alone. It can
// record each verdict in ConfigHub as an attestation.
package check

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/confighub/kubara-confighub/internal/handover"
	"github.com/confighub/kubara-confighub/internal/plan"
)

// DefaultType is the attestation type a recorded verdict carries.
const DefaultType = "LiveCheck"

const argoNamespace = "argocd"

// Run runs a command and returns its standard output. check reads Kubara's
// hub with it, through kubectl; it asks ConfigHub through a Hub.
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
	Waiting     string // why the verdict is "not yet": nothing is wrong, and the Application is not Healthy yet
	Skipped     string // why the variant was not judged
	Recorded    string // the attestation's ID
}

// Passed reports whether the variant was judged, nothing was wrong, and its
// Application is Healthy.
func (r Result) Passed() bool { return r.Skipped == "" && len(r.Problems) == 0 && r.Waiting == "" }

// NotYet reports whether nothing was wrong but the Application is not Healthy
// yet, such as while it is Progressing. It is neither a Pass nor a rejection.
func (r Result) NotYet() bool { return r.Skipped == "" && len(r.Problems) == 0 && r.Waiting != "" }

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
		OperationState struct {
			Phase     string `json:"phase"`
			Operation struct {
				Sync syncRecord `json:"sync"`
			} `json:"operation"`
			SyncResult syncRecord `json:"syncResult"`
		} `json:"operationState"`
		Resources []struct {
			Kind            string `json:"kind"`
			Namespace       string `json:"namespace"`
			Name            string `json:"name"`
			RequiresPruning bool   `json:"requiresPruning"`
			Hook            bool   `json:"hook"`
		} `json:"resources"`
	} `json:"status"`
}

// syncRecord is what Argo CD records about a sync: the sources it reads, or at
// least the revisions it syncs.
type syncRecord struct {
	Source *struct {
		RepoURL string `json:"repoURL"`
	} `json:"source"`
	Sources []struct {
		RepoURL string `json:"repoURL"`
	} `json:"sources"`
	Revision  string   `json:"revision"`
	Revisions []string `json:"revisions"`
}

// fromGit reports whether a sync names a Git source, or a revision that is a
// commit rather than an OCI digest.
func (s syncRecord) fromGit() bool {
	var names []string
	if s.Source != nil {
		names = append(names, s.Source.RepoURL)
	}
	for _, src := range s.Sources {
		names = append(names, src.RepoURL)
	}
	names = append(names, s.Revision)
	names = append(names, s.Revisions...)
	for _, n := range names {
		if n != "" && !strings.HasPrefix(n, "oci://") && !strings.HasPrefix(n, "sha256:") {
			return true
		}
	}
	return false
}

// Check judges every variant in the plan against what Kubara's hub runs.
func Check(p plan.Plan, run Run, hub Hub, opts Options) ([]Result, error) {
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
				if err := judgeRelease(&r, a, hub); err != nil {
					return results, err
				}
			}
			results = append(results, r)
		}
	}

	if opts.Record {
		for i := range results {
			if err := record(&results[i], hub, opts.Type); err != nil {
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
	if op := a.Status.OperationState; op.Phase == "Running" && (op.Operation.Sync.fromGit() || op.SyncResult.fromGit()) {
		r.Problems = append(r.Problems, "a sync Argo CD started from Git is still running, and cannot finish against the release; run handover.sh again to stop it")
	}
	if a.Status.Sync.Status != "Synced" {
		r.Problems = append(r.Problems, "sync status is "+or(a.Status.Sync.Status, "unknown"))
	}
	judgeHealth(r)
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

// judgeHealth makes health part of the verdict. Only Healthy passes. Degraded
// and Missing are wrong, and name the Application. Anything else, such as
// Progressing, is "not yet": it may still become Healthy, so it is neither a
// Pass nor a rejection.
func judgeHealth(r *Result) {
	switch r.Health {
	case "Healthy":
	case "Degraded", "Missing":
		r.Problems = append(r.Problems, fmt.Sprintf("Argo CD reports %s as %s", r.Application, r.Health))
	default:
		r.Waiting = fmt.Sprintf("Argo CD reports %s as %s", r.Application, or(r.Health, "having no health yet"))
	}
}

// judgeRelease checks that Argo CD runs the latest release ConfigHub published.
func judgeRelease(r *Result, a *application, hub Hub) error {
	rels, err := hub.Releases(r.Space)
	if err != nil {
		return fmt.Errorf("%s: listing releases: %w", r.Space, err)
	}
	var latest *HubRelease
	for i := range rels {
		if rels[i].Published && (latest == nil || rels[i].Num > latest.Num) {
			latest = &rels[i]
		}
	}
	if latest == nil {
		r.Problems = append(r.Problems, "ConfigHub has published no release for it")
		return nil
	}
	r.Release = latest.Num
	if a.Status.Sync.Revision != latest.ManifestDigest {
		r.Problems = append(r.Problems, fmt.Sprintf("Argo CD runs %s, and the latest release, %d, is %s", short(a.Status.Sync.Revision), r.Release, short(latest.ManifestDigest)))
	}
	return nil
}

// record writes the verdict as an attestation on the released revisions: a
// Pass, or a rejection naming what is wrong. A "not yet" records nothing.
func record(r *Result, hub Hub, typ string) error {
	if r.Skipped != "" || r.Release == 0 || r.NotYet() {
		return nil
	}
	a := Attestation{
		Space: r.Space, Type: typ, Revision: "LastReleasedRevisionNum",
		Claims: map[string]string{
			"argocd.argoproj.io/application": r.Application,
			"argocd.argoproj.io/revision":    r.Revision,
			"argocd.argoproj.io/health":      or(r.Health, "none"),
		},
		Note: "cub kubara check: " + r.Application + " reads and runs release " + fmt.Sprint(r.Release) + ", synced, healthy, prunes nothing, keeps Secret values",
	}
	if len(r.Problems) > 0 {
		a.Note = "cub kubara check: " + strings.Join(r.Problems, "; ")
		if r.Waiting != "" {
			a.Note += "; " + r.Waiting
		}
		a.Reject = true
	}
	id, err := hub.Attest(a)
	if err != nil {
		return fmt.Errorf("%s: recording the verdict: %w", r.Space, err)
	}
	r.Recorded = id
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

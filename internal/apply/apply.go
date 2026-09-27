// Package apply writes a plan as files and one script, apply.sh, of cub
// steps that create the governed records in ConfigHub: a component and a base
// per Kubara component, a rollout workflow on each base, and a variant per
// cluster carrying that cluster's own render. It runs nothing itself.
//
// It changes nothing in Kubara or on a cluster. Kubara's hub, AppProject and
// ApplicationSets keep delivering from Git until takeover.
package apply

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/confighub/kubara-confighub/internal/plan"
)

// Renderer renders one cluster of a generated Kubara platform into dir, and
// returns the path of each render by chart directory name.
type Renderer func(kubaraDir, cluster, dir string) (map[string]string, error)

// WorkshopRenderer renders with the ConfigHub Workshop plugin's
// `cub stack from-kubara`, so cub kubara and the Workshop render a Kubara
// platform the same way.
func WorkshopRenderer(kubaraDir, cluster, dir string) (map[string]string, error) {
	cmd := exec.Command("cub", "stack", "from-kubara", kubaraDir, "--cluster", cluster, "--out", dir)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &bytes.Buffer{}
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if _, lookErr := exec.LookPath("cub"); lookErr != nil {
			return nil, fmt.Errorf("rendering needs cub and the ConfigHub Workshop plugin; install cub, then: cub plugin install confighub/cub-workshop")
		}
		if strings.Contains(msg, `unknown command "stack"`) {
			return nil, fmt.Errorf("rendering needs the ConfigHub Workshop plugin: cub plugin install confighub/cub-workshop")
		}
		return nil, fmt.Errorf("cub stack from-kubara --cluster %s: %v: %s\nA Workshop plugin older than the Kubara catalog can fail here; run cub plugin upgrade workshop, then retry", cluster, err, lastLine(msg))
	}
	entries, err := os.ReadDir(filepath.Join(dir, "renders"))
	if err != nil {
		return nil, fmt.Errorf("cub stack from-kubara wrote no renders for %s: %w", cluster, err)
	}
	out := map[string]string{}
	for _, e := range entries {
		if name, ok := strings.CutSuffix(e.Name(), ".yaml"); ok {
			out[name] = filepath.Join(dir, "renders", e.Name())
		}
	}
	return out, nil
}

type Options struct {
	Out          string
	AllowAuthors bool
	Render       Renderer
}

type Result struct {
	Script     string
	Components int
	Variants   int
	Unchanged  []string // variants on another cluster whose render equals the base, so they take no change
	Secrets    []string // Secrets whose values were left out, by component
}

// Write renders every cluster, then writes each component's base and
// per-cluster renders, its rollout workflow, the plan, and apply.sh.
func Write(p plan.Plan, opts Options) (Result, error) {
	var res Result
	if !p.Generated {
		return res, fmt.Errorf("apply needs a platform Kubara has generated; run kubara ... generate --helm in %s first", p.Source)
	}
	if len(p.Problems) > 0 {
		return res, fmt.Errorf("the plan has problems to fix first:\n  - %s", strings.Join(p.Problems, "\n  - "))
	}
	if opts.Render == nil {
		opts.Render = WorkshopRenderer
	}
	if err := os.MkdirAll(opts.Out, 0o755); err != nil {
		return res, err
	}
	// Kubara's raw renders hold Secret values, so they stay out of --out and
	// are removed once read.
	tmp, err := os.MkdirTemp("", "cub-kubara-render-")
	if err != nil {
		return res, err
	}
	defer os.RemoveAll(tmp)
	renders := map[string]map[string]string{}
	for _, st := range p.Stages {
		for _, cl := range st.Clusters {
			r, err := opts.Render(p.Source, cl.Name, filepath.Join(tmp, cl.Name))
			if err != nil {
				return res, err
			}
			renders[cl.Name] = r
		}
	}
	stageOf := map[string]string{}
	for _, st := range p.Stages {
		for _, cl := range st.Clusters {
			stageOf[cl.Name] = st.Name
		}
	}

	seenSecret := map[string]bool{}
	read := func(comp, path string) ([]byte, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		b, names, err := withoutSecretValues(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		for _, n := range names {
			if key := comp + ": " + n; !seenSecret[key] {
				seenSecret[key] = true
				res.Secrets = append(res.Secrets, key)
			}
		}
		return b, nil
	}

	var body strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&body, format+"\n", args...) }

	line(`step "1/2 A component, a base and a rollout workflow per Kubara component"`)
	type variantStep struct{ comp, cluster, stage, space, file, desc, note string }
	var variants []variantStep
	for _, c := range p.Components {
		if len(c.Variants) == 0 {
			continue
		}
		dir := filepath.Join(opts.Out, c.Name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return res, err
		}
		// The plan orders variants by stage, so the first is the cluster a change
		// reaches first.
		first := c.Variants[0].Cluster
		baseSrc, ok := renders[first][c.ChartPath]
		if !ok {
			return res, fmt.Errorf("cub stack from-kubara rendered no %s for %s", c.Name, first)
		}
		baseBytes, err := read(c.Name, baseSrc)
		if err != nil {
			return res, err
		}
		if err := os.WriteFile(filepath.Join(dir, "base.yaml"), baseBytes, 0o644); err != nil {
			return res, err
		}
		stages := componentStages(p, c)
		if err := os.WriteFile(filepath.Join(dir, "change-workflow.yaml"), []byte(workflowYAML(stages, opts.AllowAuthors)), 0o644); err != nil {
			return res, err
		}
		component := p.Prefix + "-" + c.Name
		line("cub component create %s --allow-exists --quiet", component)
		line("cub space create %s --component %s --allow-exists --quiet", c.Base, component)
		line("cub unit create --space %s %s %s/base.yaml --change-desc %s --allow-exists --quiet", c.Base, c.Name, c.Name, q(fmt.Sprintf("Kubara's %s as generated for %s: the shared base", c.Name, first)))
		line("cub changeworkflow create --space %s rollout --filename %s/change-workflow.yaml --allow-exists --quiet", c.Base, c.Name)
		line("stages_are %s rollout %s || echo %s | cub changeworkflow update --patch --space %s rollout --from-stdin --quiet", c.Base, strings.Join(stages, ","), q(stagesJSON(stages)), c.Base)
		line("approval_is %s rollout %v || echo %s | cub changeworkflow update --patch --space %s rollout --from-stdin --quiet", c.Base, opts.AllowAuthors, q(approvalJSON(opts.AllowAuthors)), c.Base)
		res.Components++
		for _, v := range c.Variants {
			src, ok := renders[v.Cluster][c.ChartPath]
			if !ok {
				return res, fmt.Errorf("cub stack from-kubara rendered no %s for %s", c.Name, v.Cluster)
			}
			b, err := read(c.Name, src)
			if err != nil {
				return res, err
			}
			step := variantStep{comp: c.Name, cluster: v.Cluster, stage: stageOf[v.Cluster], space: v.Space,
				desc: fmt.Sprintf("Kubara's values for %s", v.Cluster)}
			switch {
			case v.Cluster == first:
				step.note = "the base is this cluster's render"
			case bytes.Equal(b, baseBytes):
				step.note = fmt.Sprintf("Kubara renders it the same as on %s; no change to record", first)
				res.Unchanged = append(res.Unchanged, v.Space)
			default:
				step.file = filepath.Join(c.Name, v.Cluster+".yaml")
				if err := os.WriteFile(filepath.Join(opts.Out, step.file), b, 0o644); err != nil {
					return res, err
				}
			}
			variants = append(variants, step)
			res.Variants++
		}
	}
	line("")
	line(`step "2/2 A variant per cluster, holding that cluster's own render"`)
	for _, v := range variants {
		line("cub variant create %s %s --stage %s --space-pattern template:%s --allow-exists --quiet", v.cluster, p.Prefix+"-"+v.comp+"-base", v.stage, v.space)
		if v.file != "" {
			line("take_render %s %s %s %s", v.space, v.comp, v.file, q(v.desc))
		} else {
			line("echo %s", q(v.space+": "+v.note))
		}
	}
	writeFooter(&body)

	var s strings.Builder
	writeHeader(&s, p, res.Secrets)
	s.WriteString(body.String())
	script := filepath.Join(opts.Out, "apply.sh")
	if err := os.WriteFile(script, []byte(s.String()), 0o755); err != nil {
		return res, err
	}
	if err := os.WriteFile(filepath.Join(opts.Out, "plan.txt"), []byte(plan.Render(p)), 0o644); err != nil {
		return res, err
	}
	res.Script = script
	return res, nil
}

func writeHeader(s *strings.Builder, p plan.Plan, secrets []string) {
	var comps []string
	for _, c := range p.Components {
		comps = append(comps, c.Name)
	}
	fmt.Fprintf(s, `#!/usr/bin/env bash
# Bring the Kubara platform in %s into ConfigHub: %s.
# Written by `+"`cub kubara apply`"+`. Read it, then run it:
#
#   bash apply.sh
#
# cub uses its current context; set CUB_CONTEXT to choose another.
# It only creates records in ConfigHub. It changes nothing in Kubara or on any
# cluster: Kubara's hub, AppProject and ApplicationSets keep delivering from Git
# until takeover. All of it is safe to re-run.
`, p.Source, strings.Join(comps, ", "))
	if len(secrets) > 0 {
		s.WriteString("#\n# These Secrets are uploaded with their keys and without their values, which\n# belong in the cluster's secret store:\n")
		for _, name := range secrets {
			s.WriteString("#   " + name + "\n")
		}
	}
	s.WriteString(`set -euo pipefail
cd "$(dirname "$0")"
step() { printf '\n== %s\n' "$*"; }
# A re-run patches a workflow only where it differs from this plan: the stages,
# when a cluster joins in a stage the workflow does not have yet, and the
# approval rule, when --allow-authors changes. Anything else set since is kept.
stages_are() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.Stages[].Name] | join(",")')" = "$3" ]; }
approval_is() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.AttestationPrerequisites[]? | select(.Name == "approval") | (.AllowAuthors // false)] | first // false | tostring')" = "$3" ]; }
# A variant takes its cluster's render once, as the first change after the
# clone. Later revisions are changes made in ConfigHub, which a re-run leaves
# alone.
take_render() {
  if [ "$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)" -le 2 ]; then
    cub unit update --space "$1" "$2" "$3" --change-desc "$4" --quiet
  else
    echo "$1/$2 already has its cluster's render"
  fi
}

step "0/2 Check before changing anything"
cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }
cub changeworkflow --help >/dev/null 2>&1 || { echo "this cub has no change workflows; upgrade cub"; exit 1; }

`)
}

func writeFooter(s *strings.Builder) {
	s.WriteString(`
step "Done"
echo "Every Kubara component now has a base and a variant per cluster in ConfigHub."
echo "To change the platform: edit a base, promote the change stage by stage with"
echo "  cub changeorder create ... then cub variant promote and cub variant approve."
echo "Kubara's hub still delivers from Git; pointing it at approved releases is takeover."
`)
}

// componentStages is the stage order this component's variants span.
func componentStages(p plan.Plan, c plan.Component) []string {
	has := map[string]bool{}
	for _, v := range c.Variants {
		for _, st := range p.Stages {
			for _, cl := range st.Clusters {
				if cl.Name == v.Cluster {
					has[st.Name] = true
				}
			}
		}
	}
	var out []string
	for _, st := range p.Stages {
		if has[st.Name] {
			out = append(out, st.Name)
		}
	}
	return out
}

func workflowYAML(stages []string, allowAuthors bool) string {
	var b strings.Builder
	b.WriteString(`# The order a change moves through this component's clusters, and what each
# stage waits for. ConfigHub enforces both on the server.
#
# AllowAuthors lets the person who promoted a change also approve it, which one
# person trying this needs. Set it to false once a second person approves.
AttestationPrerequisites:
  - Name: approval
    Type: Approval
    Count: 1
`)
	fmt.Fprintf(&b, "    AllowAuthors: %v\nStages:\n", allowAuthors)
	for i, st := range stages {
		fmt.Fprintf(&b, "  - Name: %s\n    WhereSpace: \"Labels.Stage = '%s'\"\n", st, st)
		if i > 0 {
			b.WriteString("    Prerequisites:\n      - Released\n")
		}
		b.WriteString("    ReleasePrerequisites:\n      - approval\n")
	}
	return b.String()
}

type stageJSON struct {
	Name                 string
	WhereSpace           string
	Prerequisites        []string `json:",omitempty"`
	ReleasePrerequisites []string
}

// stagesJSON is the patch that sets a workflow's stages to the plan's.
func stagesJSON(stages []string) string {
	out := make([]stageJSON, len(stages))
	for i, st := range stages {
		out[i] = stageJSON{Name: st, WhereSpace: fmt.Sprintf("Labels.Stage = '%s'", st), ReleasePrerequisites: []string{"approval"}}
		if i > 0 {
			out[i].Prerequisites = []string{"Released"}
		}
	}
	b, _ := json.Marshal(map[string]any{"Stages": out})
	return string(b)
}

// approvalJSON is the patch that sets a workflow's approval rule to the plan's.
func approvalJSON(allowAuthors bool) string {
	b, _ := json.Marshal(map[string]any{"AttestationPrerequisites": []map[string]any{
		{"Name": "approval", "Type": "Approval", "Count": 1, "AllowAuthors": allowAuthors},
	}})
	return string(b)
}

func q(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

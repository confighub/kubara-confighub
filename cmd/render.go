package cmd

import (
	"fmt"
	"io"
	"path/filepath"

	"github.com/confighub/kubara-confighub/internal/render"
)

// printRender summarises a render: each cluster, each service on it, and the
// Secrets written without their values.
func printRender(w io.Writer, m render.Manifest, out string) {
	fmt.Fprintf(w, "Rendered %d cluster(s) as Kubara's ApplicationSets deliver them. No cluster or ConfigHub server was contacted.\n", len(m.Clusters))
	var secrets []string
	for _, cl := range m.Clusters {
		fmt.Fprintf(w, "  %s (%s, %s)\n", cl.Name, or(cl.Type, "no type"), or(cl.Stage, "no stage"))
		for _, s := range cl.Services {
			if s.Delivery == "bootstrap" {
				fmt.Fprintf(w, "    %-24s %d CRDs, what kubara bootstrap applies", s.Name, s.Objects)
				if s.LeftOut > 0 {
					fmt.Fprintf(w, "; %d other object(s) in the chart left out", s.LeftOut)
				}
				fmt.Fprintln(w)
			} else {
				fmt.Fprintf(w, "    %-24s %d objects, release %s in %s, %d values file(s)\n", s.Name, s.Objects, s.Release, s.Namespace, len(s.ValuesFiles))
			}
			for _, sec := range s.Secrets {
				secrets = append(secrets, cl.Name+"/"+s.Name+": "+sec)
			}
		}
		owned, open := 0, 0
		for _, sh := range cl.Shared {
			if sh.Owner != "" {
				owned++
			} else {
				open++
			}
		}
		if owned > 0 {
			fmt.Fprintf(w, "    %d object(s) rendered twice are owned by bootstrap-crds; render.json lists them under shared\n", owned)
		}
		if open > 0 {
			fmt.Fprintf(w, "    %d object(s) are rendered by two services with no owner; render.json lists them under shared\n", open)
		}
	}
	if len(secrets) > 0 {
		fmt.Fprintf(w, "These Secrets are written with their keys and without their values:\n")
		for _, s := range secrets {
			fmt.Fprintf(w, "  %s\n", s)
		}
	}
	fmt.Fprintf(w, "Wrote %s\n", filepath.Join(out, render.ManifestFile))
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// Command kubara-confighub is `cub kubara`, published as a cub CLI plugin:
//
//	cub plugin install confighub/kubara-confighub
//	cub kubara services
//	cub kubara init --out my-platform --services cert-manager,traefik
//	cub kubara plan my-platform
//
// It is the Kubara user's way into ConfigHub. The recorded proofs and their
// runners stay npm scripts: they need the source tree and only run in this
// repository or its CI.
package main

import (
	"fmt"
	"os"

	"github.com/confighub/sdk/core/plugin"

	"github.com/confighub/kubara-confighub/cmd"
)

func main() {
	// cub runs this binary with the hook environment set when it installs or
	// upgrades the plugin; HandleHook writes cub-plugin.yaml, so the manifest
	// can never drift from the commands the binary implements.
	manifest := plugin.Manifest{
		Name:    "kubara",
		Version: cmd.Version(),
		Commands: []plugin.Command{{
			Name:    "kubara",
			Summary: "Run a Kubara platform through ConfigHub, with Workshop evidence for each chart",
		}},
	}
	if handled, err := plugin.HandleHook(manifest); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	cmd.Execute()
}

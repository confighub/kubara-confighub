package apply

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var docSeparator = regexp.MustCompile(`(?m)^---[ \t]*$\n?`)

// secretChecksum is the pod annotation charts set to a hash of a Secret's
// values, so pods restart when it changes.
var secretChecksum = regexp.MustCompile(`(?m)^(\s+checksum/secrets?:[ \t]*)[0-9a-f]{64}[ \t]*$`)

// withoutSecretValues empties every value under data and stringData in each
// Secret of a multi-document render, keeping its keys, and names each Secret it
// changed. Charts generate some of these values at render time (a Grafana admin
// password, for one), so they are credentials, and they differ on every render.
// A Secret's values belong in the cluster's secret store, not in ConfigHub.
// A checksum/secret annotation, which hashes those values, is emptied with
// them. Every other line is kept byte for byte.
func withoutSecretValues(render []byte) ([]byte, []string, error) {
	docs := docSeparator.Split(string(render), -1)
	var names []string
	for i, doc := range docs {
		if !strings.Contains(doc, "kind: Secret") {
			continue
		}
		var root yaml.Node
		if err := yaml.Unmarshal([]byte(doc), &root); err != nil {
			return nil, nil, err
		}
		if len(root.Content) == 0 || root.Content[0].Kind != yaml.MappingNode {
			continue
		}
		top := root.Content[0]
		if value(top, "kind") == nil || value(top, "kind").Value != "Secret" {
			continue
		}
		emptied := 0
		for _, field := range []string{"data", "stringData"} {
			m := value(top, field)
			if m == nil || m.Kind != yaml.MappingNode {
				continue
			}
			for j := 1; j < len(m.Content); j += 2 {
				m.Content[j] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: ""}
				emptied++
			}
		}
		if emptied == 0 {
			continue
		}
		var buf bytes.Buffer
		enc := yaml.NewEncoder(&buf)
		enc.SetIndent(2)
		if err := enc.Encode(&root); err != nil {
			return nil, nil, err
		}
		docs[i] = buf.String()
		name := "Secret"
		if meta := value(top, "metadata"); meta != nil {
			if ns := value(meta, "namespace"); ns != nil {
				name += " " + ns.Value + "/"
			} else {
				name += " "
			}
			if n := value(meta, "name"); n != nil {
				name += n.Value
			}
		}
		unit := "values"
		if emptied == 1 {
			unit = "value"
		}
		names = append(names, fmt.Sprintf("%s (%d %s)", name, emptied, unit))
	}
	out := strings.Join(docs, "---\n")
	if len(names) > 0 {
		// The hash is of values that are no longer here, and a chart that
		// generates a random password gives it a new hash on every render.
		out = secretChecksum.ReplaceAllString(out, `${1}""`)
	}
	return []byte(out), names, nil
}

func value(m *yaml.Node, key string) *yaml.Node {
	if m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

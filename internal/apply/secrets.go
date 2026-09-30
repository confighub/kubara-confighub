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

// WithoutSecretValues empties every Secret value in a multi-document render,
// keeping each key, and names each Secret it changed. See withoutSecretValues.
func WithoutSecretValues(render []byte) ([]byte, []string, error) {
	return withoutSecretValues(render)
}

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
		var root yaml.Node
		if err := yaml.Unmarshal([]byte(doc), &root); err != nil {
			return nil, nil, err
		}
		// Every document is parsed, whatever its style: kind: "Secret" and a
		// Secret inside a List are Secrets too.
		found := emptySecrets(&root)
		if len(found) == 0 {
			continue
		}
		var buf bytes.Buffer
		enc := yaml.NewEncoder(&buf)
		enc.SetIndent(2)
		if err := enc.Encode(&root); err != nil {
			return nil, nil, err
		}
		docs[i] = buf.String()
		names = append(names, found...)
	}
	out := strings.Join(docs, "---\n")
	if len(names) > 0 {
		// The hash is of values that are no longer here, and a chart that
		// generates a random password gives it a new hash on every render.
		out = secretChecksum.ReplaceAllString(out, `${1}""`)
	}
	return []byte(out), names, nil
}

// emptySecrets walks a document and empties the data and stringData values of
// every Secret in it, naming each one it changed.
func emptySecrets(n *yaml.Node) []string {
	var names []string
	if n.Kind == yaml.MappingNode {
		if k := value(n, "kind"); k != nil && k.Kind == yaml.ScalarNode && k.Value == "Secret" {
			emptied := 0
			for _, field := range []string{"data", "stringData"} {
				m := value(n, field)
				if m == nil || m.Kind != yaml.MappingNode {
					continue
				}
				for j := 1; j < len(m.Content); j += 2 {
					m.Content[j] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: ""}
					emptied++
				}
			}
			if emptied > 0 {
				names = append(names, secretName(n, emptied))
			}
			return names
		}
	}
	for _, c := range n.Content {
		names = append(names, emptySecrets(c)...)
	}
	return names
}

func secretName(n *yaml.Node, emptied int) string {
	name := "Secret"
	if meta := value(n, "metadata"); meta != nil {
		if ns := value(meta, "namespace"); ns != nil {
			name += " " + ns.Value + "/"
		} else {
			name += " "
		}
		if nm := value(meta, "name"); nm != nil {
			name += nm.Value
		}
	}
	unit := "values"
	if emptied == 1 {
		unit = "value"
	}
	return fmt.Sprintf("%s (%d %s)", name, emptied, unit)
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

package check

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	spaceID = "11111111-1111-4111-8111-111111111111"
	attID   = "0f0e0d0c-0b0a-4908-8706-050403020100"
)

// stubHub is ConfigHub's API as the SDK client meets it: one Space, "s", with
// two published releases and one not, and a Space, "unreleased", where no Unit
// has a released revision. It records each request.
func stubHub(t *testing.T) (*SDKHub, *[]string) {
	t.Helper()
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		q := r.URL.Query()
		asked = append(asked, r.Method+" "+r.URL.Path+" where="+q.Get("where")+" auth="+r.Header.Get("Authorization")+" agent="+r.Header.Get("User-Agent")+" body="+string(body))
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		switch {
		case p == "/api/space":
			switch q.Get("where") {
			case "Slug = 's'":
				w.Write([]byte(`[{"Space":{"SpaceID":"` + spaceID + `","Slug":"s"}}]`))
			case "Slug = 'unreleased'":
				w.Write([]byte(`[{"Space":{"SpaceID":"` + spaceID + `","Slug":"unreleased"}}]`))
			default:
				w.Write([]byte(`[]`))
			}
		case p == "/api/space/"+spaceID+"/release":
			// Out of order, as the server may return them.
			w.Write([]byte(`[
				{"Release":{"ReleaseNum":2,"ManifestDigest":"sha256:m2","Published":true}},
				{"Release":{"ReleaseNum":3,"ManifestDigest":"sha256:m3","Published":false}},
				{"Release":{"ReleaseNum":1,"ManifestDigest":"sha256:m1","Published":true}}]`))
		case p == "/api/space/"+spaceID+"/attestation":
			if strings.Contains(string(body), `"Note":"nothing released"`) {
				w.Write([]byte(`{"SkippedUnits":[{"UnitSlug":"u","Reason":"no such revision"}]}`))
				return
			}
			w.Write([]byte(`{"Attestation":{"AttestationID":"` + attID + `"}}`))
		default:
			http.Error(w, `{"Message":"unexpected `+p+`"}`, http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CUB_SERVER", srv.URL)
	t.Setenv("CUB_TOKEN", "token")
	t.Setenv("CUB_CONTEXT", "")
	t.Setenv("CUB_CONFIG", t.TempDir())
	return NewHub("test"), &asked
}

// cubConfig writes a cub config directory with two contexts for the server at
// url, "first" the current one, and points CUB_CONFIG at it, as cub does for
// a plugin. There is no CUB_SERVER or CUB_TOKEN.
func cubConfig(t *testing.T, url string) {
	t.Helper()
	dir := t.TempDir()
	config := `apiVersion: v1
kind: Config
currentContext: first
contexts:
    - name: first
      coordinate:
        serverURL: ` + url + `
      metadata:
        tokenFile: first.json
    - name: second
      coordinate:
        serverURL: ` + url + `
      metadata:
        tokenFile: second.json
`
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "tokens"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first", "second"} {
		if err := os.WriteFile(filepath.Join(dir, "tokens", name+".json"), []byte(`{"accessToken":"token-of-`+name+`"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CUB_SERVER", "")
	t.Setenv("CUB_TOKEN", "")
	t.Setenv("CUB_CONFIG", dir)
}

// Without CUB_SERVER and CUB_TOKEN, the login is cub's current context, read
// from the directory CUB_CONFIG names, and CUB_CONTEXT chooses another.
func TestSDKHubUsesTheActiveContext(t *testing.T) {
	h, asked := stubHub(t)
	cubConfig(t, os.Getenv("CUB_SERVER"))
	if _, err := h.Releases("s"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(last(asked), "auth=Bearer token-of-first ") {
		t.Errorf("want the current context's token: %s", last(asked))
	}
	t.Setenv("CUB_CONTEXT", "second")
	if _, err := h.Releases("s"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(last(asked), "auth=Bearer token-of-second ") {
		t.Errorf("CUB_CONTEXT chooses the context: %s", last(asked))
	}
	t.Setenv("CUB_CONTEXT", "third")
	if _, err := h.Releases("s"); err == nil || !strings.Contains(err.Error(), "third") {
		t.Errorf("a context cub does not have is an error that names it: %v", err)
	}
}

func last(asked *[]string) string { return (*asked)[len(*asked)-1] }

// The Space is found by its slug, and every release comes back, published or
// not, as cub release list --space gave them. The login is the one cub passes
// a plugin.
func TestSDKHubListsReleases(t *testing.T) {
	h, asked := stubHub(t)
	rs, err := h.Releases("s")
	if err != nil {
		t.Fatal(err)
	}
	want := []HubRelease{{2, "sha256:m2", true}, {3, "sha256:m3", false}, {1, "sha256:m1", true}}
	if len(rs) != len(want) {
		t.Fatalf("releases = %+v", rs)
	}
	for i := range want {
		if rs[i] != want[i] {
			t.Errorf("release %d = %+v, want %+v", i, rs[i], want[i])
		}
	}
	if len(*asked) != 2 {
		t.Fatalf("want two requests, the Space and its releases: %v", *asked)
	}
	if first := (*asked)[0]; !strings.HasPrefix(first, "GET /api/space where=Slug = 's' ") {
		t.Errorf("the Space is found by its slug: %s", first)
	}
	sent := last(asked)
	if !strings.HasPrefix(sent, "GET /api/space/"+spaceID+"/release where= ") {
		t.Errorf("every release of the Space is listed, with no filter: %s", sent)
	}
	if !strings.Contains(sent, "auth=Bearer token") || !strings.Contains(sent, "agent=cub-kubara/test") {
		t.Errorf("the request carries the plugin's login and names the plugin: %s", sent)
	}
}

// A Space ConfigHub does not have is an error that names it, and nothing is
// asked about its releases.
func TestSDKHubNamesAMissingSpace(t *testing.T) {
	h, asked := stubHub(t)
	_, err := h.Releases("gone")
	if err == nil || !strings.Contains(err.Error(), "gone") {
		t.Errorf("want an error naming the Space: %v", err)
	}
	for _, a := range *asked {
		if strings.Contains(a, "/release") {
			t.Errorf("a Space that is not found has no releases to ask for: %s", a)
		}
	}
}

// The attestation covers every Unit of the Space at the revision named, as
// cub attestation create does without --where. A Pass leaves the result to
// the server, as cub does; a rejection is a Fail.
func TestSDKHubRecordsAnAttestation(t *testing.T) {
	h, asked := stubHub(t)
	a := Attestation{Space: "s", Type: "LiveCheck", Revision: "LastReleasedRevisionNum",
		Claims: map[string]string{"argocd.argoproj.io/health": "Healthy"}, Note: "n"}
	id, err := h.Attest(a)
	if err != nil || id != attID {
		t.Fatalf("the attestation's ID comes back: %q %v", id, err)
	}
	sent := last(asked)
	if !strings.HasPrefix(sent, "POST /api/space/"+spaceID+"/attestation ") {
		t.Errorf("want a POST to the Space's attestations: %s", sent)
	}
	body := sent[strings.Index(sent, " body=")+len(" body="):]
	if want := `{"Claims":{"argocd.argoproj.io/health":"Healthy"},"ExpiresAt":"0001-01-01T00:00:00Z","Note":"n","Revision":"LastReleasedRevisionNum","Type":"LiveCheck"}`; strings.TrimSpace(body) != want {
		t.Errorf("body:\n%s\nwant:\n%s", body, want)
	}
	if strings.Contains(sent, "dry_run") {
		t.Errorf("a recorded verdict is not a dry run: %s", sent)
	}
	a.Reject = true
	if _, err := h.Attest(a); err != nil || !strings.Contains(last(asked), `"Result":"Fail"`) {
		t.Errorf("a rejection is a Fail: %v %s", err, last(asked))
	}
}

// When no Unit has the revision, ConfigHub records nothing and says which
// Units it skipped. That is no error, and there is no ID to report.
func TestSDKHubRecordsNothingWithoutARevision(t *testing.T) {
	h, _ := stubHub(t)
	id, err := h.Attest(Attestation{Space: "unreleased", Type: "LiveCheck", Revision: "LastReleasedRevisionNum", Note: "nothing released"})
	if err != nil || id != "" {
		t.Errorf("want no ID and no error: %q %v", id, err)
	}
}

// With no login, the error says how to get one before anything is asked.
func TestSDKHubWantsALogin(t *testing.T) {
	t.Setenv("CUB_SERVER", "")
	t.Setenv("CUB_TOKEN", "")
	t.Setenv("CUB_CONTEXT", "")
	t.Setenv("CUB_CONFIG", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	h := NewHub("test")
	for _, err := range []error{
		func() error { _, err := h.Releases("s"); return err }(),
		func() error { _, err := h.Attest(Attestation{Space: "s"}); return err }(),
	} {
		if err == nil || !strings.Contains(err.Error(), "no ConfigHub login") || !strings.Contains(err.Error(), "cub auth login") {
			t.Errorf("want an error that says to log in: %v", err)
		}
	}
}

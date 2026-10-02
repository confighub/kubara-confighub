package check

import (
	"context"
	"fmt"

	"github.com/confighub/sdk/core/cubapi"
	goclientnew "github.com/confighub/sdk/core/openapi/goclient-new"
)

// SDKHub answers Hub through the ConfigHub SDK, as the user cub is logged in
// as: the server and token cub passes a plugin (CUB_SERVER and CUB_TOKEN), or
// the active context, which CUB_CONTEXT chooses.
type SDKHub struct {
	userAgent string
}

// NewHub is the Hub the commands use. It connects when asked something, so a
// command that asks ConfigHub nothing needs no login.
func NewHub(version string) *SDKHub {
	return &SDKHub{userAgent: "cub-kubara/" + version}
}

// client reads the login again for each question, as running cub did. That is
// a file read, not a request.
func (h *SDKHub) client(ctx context.Context) (*cubapi.Client, error) {
	c, err := h.resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("no ConfigHub login: run cub auth login, or set CUB_SERVER and CUB_TOKEN (%w)", err)
	}
	return c, nil
}

// resolve is cubapi.ResolveClient, except for where it looks for cub's
// config. CUB_CONFIG names cub's config directory, and cub sets it for every
// plugin. ResolveClient in SDK core v0.8.0 reads that directory as the config
// file, and fails; LoadConfig with no path finds config.yaml inside it.
func (h *SDKHub) resolve(ctx context.Context) (*cubapi.Client, error) {
	opts := cubapi.ClientOptions{UserAgent: h.userAgent}
	env, err := cubapi.LoadEnvironment(ctx)
	if err != nil {
		return nil, err
	}
	if env.HasCredentials() {
		return cubapi.NewClientFromEnvironment(ctx, opts)
	}
	store, err := cubapi.LoadConfig("")
	if err != nil {
		return nil, err
	}
	if env.Context != "" {
		if err := store.Use(env.Context); err != nil {
			return nil, err
		}
	}
	return cubapi.NewClientFromConfig(ctx, store, opts)
}

func (h *SDKHub) space(ctx context.Context, c *cubapi.Client, slug string) (goclientnew.UUID, error) {
	s, err := cubapi.ResolveSpace(ctx, c, cubapi.ParseRef(slug), cubapi.ResolveOpts{})
	if err != nil {
		return goclientnew.UUID{}, err
	}
	if s == nil || s.Space == nil {
		return goclientnew.UUID{}, fmt.Errorf("space %s not found", slug)
	}
	return s.Space.SpaceID, nil
}

// Releases lists a Space's releases, as cub release list --space does.
func (h *SDKHub) Releases(space string) ([]HubRelease, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	id, err := h.space(ctx, c, space)
	if err != nil {
		return nil, err
	}
	res, err := c.API.ListExtendedReleasesWithResponse(ctx, id, &goclientnew.ListExtendedReleasesParams{})
	if cubapi.IsAPIError(err, res) {
		return nil, cubapi.InterpretErrorGeneric(err, res)
	}
	var out []HubRelease
	if res.JSON200 == nil {
		return out, nil
	}
	for _, er := range *res.JSON200 {
		if er.Release == nil {
			continue
		}
		out = append(out, HubRelease{Num: int(er.Release.ReleaseNum), ManifestDigest: er.Release.ManifestDigest, Published: er.Release.Published})
	}
	return out, nil
}

// Attest records what cub attestation create --space --type --revision
// --claim --note [--reject] does: one attestation covering that revision of
// every Unit in the Space. A Pass leaves the result to the server, as cub
// does; a rejection is a Fail.
func (h *SDKHub) Attest(a Attestation) (string, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return "", err
	}
	id, err := h.space(ctx, c, a.Space)
	if err != nil {
		return "", err
	}
	req := goclientnew.AttestationCreateRequest{
		Type:     a.Type,
		Note:     a.Note,
		Claims:   a.Claims,
		Revision: a.Revision,
	}
	if a.Reject {
		req.Result = "Fail"
	}
	out, err := cubapi.CreateAttestation(ctx, c, id, req, false)
	if err != nil {
		return "", err
	}
	if out.Attestation == nil {
		return "", nil
	}
	return out.Attestation.AttestationID.String(), nil
}

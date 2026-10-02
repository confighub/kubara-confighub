package check

// check asks ConfigHub what it holds through the SDK, in this process, rather
// than by running cub and reading what it prints. Hub is everything it asks;
// the SDK-backed answer is in hub_sdk.go, and tests stand in for it.

// Hub is what check asks ConfigHub at run time.
type Hub interface {
	// Releases lists the Space's releases, published or not.
	Releases(space string) ([]HubRelease, error)
	// Attest records an attestation and returns its ID. The ID is empty when
	// no Unit in the Space has the revision named, so nothing was recorded.
	Attest(a Attestation) (string, error)
}

// HubRelease is one release of a Space.
type HubRelease struct {
	Num            int
	ManifestDigest string
	Published      bool
}

// Attestation is a verdict recorded on one revision of each Unit in a Space.
type Attestation struct {
	Space    string
	Type     string
	Revision string // as cub names one, such as LastReleasedRevisionNum
	Claims   map[string]string
	Reject   bool
	Note     string
}

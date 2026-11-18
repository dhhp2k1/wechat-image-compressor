package update

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestMirrorFallbackAndVerification(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("exact bytes of the Windows release")
	hash := sha256.Sum256(payload)
	manifest, err := Sign(Release{
		Version: "v2.10.0", Asset: AssetName, Size: int64(len(payload)), SHA256: hex.EncodeToString(hash[:]),
	}, private)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Replace(signed, []byte("v2.10.0"), []byte("v3.10.0"), 1)
	if _, err := Parse(tampered, public); err == nil {
		t.Fatal("accepted a version with a tampered signature")
	}
	if !Newer("v2.10.0", "v2.9.99") || Newer("v2.9.99", "v2.10.0") || Newer("v2.10.0-beta", "v2.9.99") {
		t.Fatal("stable version ordering failed")
	}

	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/mirror/latest/download/" + ManifestName:
			w.Write(signed)
		case "/official/latest/download/" + ManifestName:
			http.Error(w, "unreachable", http.StatusServiceUnavailable)
		case "/other/latest/download/" + ManifestName:
			w.Write(tampered)
		case "/mirror/download/v2.10.0/" + AssetName:
			w.Write(bytes.Repeat([]byte("x"), len(payload)))
		case "/other/download/v2.10.0/" + AssetName:
			w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	sources := []Source{
		{Base: server.URL + "/official"},
		{Base: server.URL + "/mirror"},
		{Base: server.URL + "/other"},
	}
	if _, err := checkSource(t.Context(), server.Client(), sources[1], public); err != nil {
		t.Fatalf("test mirror failed: %v", err)
	}
	candidate, err := Check(t.Context(), server.Client(), sources, public)
	if err != nil || candidate.Source != sources[1] || candidate.Manifest != manifest {
		t.Fatalf("expected the verified mirror release, got %+v (%v)", candidate, err)
	}
	dir := t.TempDir()
	target, err := Download(t.Context(), server.Client(), sources, candidate, dir)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(actual, payload) {
		t.Fatalf("expected the validated bytes, got %q (%v)", actual, err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatalf("rejected downloads must be removed, got %v (%v)", files, err)
	}
	if _, err := Download(t.Context(), server.Client(), sources[:2], candidate, t.TempDir()); err == nil {
		t.Fatal("accepted a corrupt download when no valid mirror was available")
	}
}

func TestHTTPClientNegotiatesHTTP1(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test-Protocol", r.Proto)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()

	client := HTTPClient()
	defer client.CloseIdleConnections()
	transport := client.Transport.(*http.Transport)
	transport.TLSClientConfig.RootCAs = server.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if got := response.Header.Get("X-Test-Protocol"); got != "HTTP/1.1" {
		t.Fatalf("expected HTTP/1.1, got %s", got)
	}
}

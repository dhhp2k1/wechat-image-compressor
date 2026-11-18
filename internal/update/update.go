package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	AssetName    = "WeChatImageCompressor-windows-amd64.exe"
	ManifestName = "update-windows-amd64.json"
	MaxAssetSize = 80 << 20
	releasesURL  = "https://github.com/dhhp2k1/wechat-image-compressor/releases"
)

type Release struct {
	Version string `json:"version"`
	Asset   string `json:"asset"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

type Manifest struct {
	Release
	Signature string `json:"signature"`
}

func versionParts(version string) ([3]int, error) {
	var result [3]int
	parts := strings.Split(strings.TrimPrefix(version, "v"), ".")
	if !strings.HasPrefix(version, "v") || len(parts) != len(result) {
		return result, errors.New("版本格式应为 vX.Y.Z")
	}
	for i, part := range parts {
		value, err := strconv.ParseUint(part, 10, 31)
		if err != nil || strconv.FormatUint(value, 10) != part {
			return result, errors.New("版本格式应为 vX.Y.Z")
		}
		result[i] = int(value)
	}
	return result, nil
}

func Newer(candidate, installed string) bool {
	a, errA := versionParts(candidate)
	b, errB := versionParts(installed)
	if errA != nil || errB != nil {
		return false
	}
	for i, value := range a {
		if value != b[i] {
			return value > b[i]
		}
	}
	return false
}

func (r Release) signedBytes() ([]byte, error) {
	if _, err := versionParts(r.Version); err != nil {
		return nil, err
	}
	if r.Asset != AssetName || r.Size <= 0 || r.Size > MaxAssetSize {
		return nil, errors.New("发布文件名或大小无效")
	}
	hash, err := hex.DecodeString(r.SHA256)
	if err != nil || len(hash) != sha256.Size {
		return nil, errors.New("发布文件摘要无效")
	}
	return json.Marshal(r)
}

func Sign(r Release, privateKey ed25519.PrivateKey) (Manifest, error) {
	data, err := r.signedBytes()
	if err != nil {
		return Manifest{}, err
	}
	sig := ed25519.Sign(privateKey, data)
	return Manifest{r, base64.StdEncoding.EncodeToString(sig)}, nil
}

func Parse(data []byte, key ed25519.PublicKey) (Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, errors.New("发布清单格式无效")
	}
	body, err := manifest.Release.signedBytes()
	if err != nil {
		return Manifest{}, err
	}
	sig, err := base64.StdEncoding.DecodeString(manifest.Signature)
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, body, sig) {
		return Manifest{}, errors.New("发布签名验证失败")
	}
	return manifest, nil
}

func (r Release) CopyVerified(dst io.Writer, src io.Reader) error {
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(dst, hash), io.LimitReader(src, r.Size+1))
	if err != nil {
		return err
	}
	if size != r.Size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), r.SHA256) {
		return errors.New("更新文件校验失败")
	}
	return nil
}

type Source struct {
	Base      string
	Forwarder string
}

func (s Source) manifestURL() string {
	return s.Forwarder + s.Base + "/latest/download/" + ManifestName
}

func (s Source) assetURL(r Release) string {
	return s.Forwarder + s.Base + "/download/" + r.Version + "/" + r.Asset
}

func Sources(custom string) []Source {
	sources := []Source{{Base: releasesURL}}
	if u, err := url.Parse(strings.TrimSpace(custom)); err == nil && u.Scheme == "https" &&
		u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" {
		sources = append(sources, Source{Base: strings.TrimRight(u.String(), "/")})
	}
	for _, forwarder := range []string{"https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/"} {
		sources = append(sources, Source{Base: releasesURL, Forwarder: forwarder})
	}
	return sources
}

func HTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 5 * time.Second
	transport.ResponseHeaderTimeout = 8 * time.Second
	// HTTP/1.1 also works on networks that interrupt GitHub's HTTP/2 connections.
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
	transport.TLSClientConfig = &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
	}
	return &http.Client{
		Transport: transport,
		Timeout:   90 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" || req.URL.User != nil || len(via) >= 8 {
				return errors.New("更新链接重定向无效")
			}
			return nil
		},
	}
}

type Candidate struct {
	Manifest Manifest
	Source   Source
}

func Check(ctx context.Context, client *http.Client, sources []Source, key ed25519.PublicKey) (Candidate, error) {
	type result struct {
		index int
		value Candidate
		err   error
	}
	results := make(chan result, len(sources))
	for i, source := range sources {
		go func() {
			r, err := checkSource(ctx, client, source, key)
			results <- result{i, Candidate{r, source}, err}
		}()
	}
	var best Candidate
	bestIndex := len(sources)
	var missingOfficial bool
	for range sources {
		r := <-results
		if r.err != nil {
			missingOfficial = missingOfficial || (r.index == 0 && errors.Is(r.err, errNotFound))
			continue
		}
		if best.Manifest.Version == "" || Newer(r.value.Manifest.Version, best.Manifest.Version) ||
			(r.value.Manifest.Version == best.Manifest.Version && r.index < bestIndex) {
			best, bestIndex = r.value, r.index
		}
	}
	if bestIndex < len(sources) || missingOfficial {
		return best, nil
	}
	return Candidate{}, errors.New("无法从更新渠道验证版本")
}

var errNotFound = errors.New("发布清单不存在")

func checkSource(parent context.Context, client *http.Client, source Source, key ed25519.PublicKey) (Manifest, error) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	res, err := fetch(ctx, client, source.manifestURL())
	if err != nil {
		return Manifest{}, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return Manifest{}, errNotFound
	}
	if res.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	const maxManifest = 16 << 10
	body, err := io.ReadAll(io.LimitReader(res.Body, maxManifest+1))
	if err != nil || len(body) > maxManifest {
		return Manifest{}, errors.New("读取发布清单失败")
	}
	return Parse(body, key)
}

func Download(ctx context.Context, client *http.Client, sources []Source, candidate Candidate, directory string) (string, error) {
	channels := append([]Source{candidate.Source}, sources...)
	for i, source := range channels {
		if i > 0 && source == candidate.Source {
			continue
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		res, err := fetch(ctx, client, source.assetURL(candidate.Manifest.Release))
		if err != nil {
			continue
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			continue
		}
		file, err := os.CreateTemp(directory, "payload-*.exe")
		if err != nil {
			res.Body.Close()
			return "", err
		}
		err = candidate.Manifest.CopyVerified(file, res.Body)
		res.Body.Close()
		closeErr := file.Close()
		if err == nil && closeErr == nil {
			return file.Name(), nil
		}
		os.Remove(file.Name())
	}
	return "", errors.New("更新下载或文件验证失败")
}

func fetch(ctx context.Context, client *http.Client, target string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "WeChatImageCompressor")
	req.Header.Set("Cache-Control", "no-cache")
	return client.Do(req)
}

package main

import (
	"archive/zip"
	"crypto/ed25519"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/dhhp2k1/wechat-image-compressor/internal/update"
)

//go:embed ui/index.html ui/app.css ui/app.js ui/logo.png
var interfaceFiles embed.FS

var version = "v2.0.2"
var indexPage = template.Must(template.ParseFS(interfaceFiles, "ui/index.html"))

//go:embed update-key.pub
var updatePublicKey string

type app struct {
	host            string
	token           string
	quit            func()
	compressor      chan struct{}
	client          *http.Client
	sources         []update.Source
	current         update.Candidate
	updating        bool
	mu              sync.Mutex
	preferencesFile string
}

func newApp(host, token string, quit func()) *app {
	return &app{
		host: host, token: token, quit: quit, compressor: make(chan struct{}, 1),
		client: update.HTTPClient(), sources: update.Sources(os.Getenv("WECHAT_UPDATE_MIRROR")),
		preferencesFile: preferencesPath(),
	}
}

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	prefix := "/" + a.token + "/"
	if r.Host != a.host || !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	route := strings.TrimPrefix(r.URL.Path, prefix)
	if strings.HasPrefix(route, "api/") {
		if r.Method != http.MethodPost || r.Header.Get("X-WeChat-Session") != a.token {
			http.NotFound(w, r)
			return
		}
		switch route {
		case "api/compress":
			a.compress(w, r)
		case "api/zip":
			writeZIP(w, r)
		case "api/update":
			a.checkUpdate(w, r)
		case "api/install":
			a.install(w, r)
		case "api/settings":
			a.savePreferences(w, r)
		case "api/quit":
			w.WriteHeader(http.StatusNoContent)
			a.quit()
		default:
			http.NotFound(w, r)
		}
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	var name, contentType string
	switch route {
	case "":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		indexPage.ExecuteTemplate(w, "index.html", readPreferences(a.preferencesFile))
		return
	case "app.css":
		name, contentType = route, "text/css; charset=utf-8"
	case "app.js":
		name, contentType = route, "application/javascript; charset=utf-8"
	case "logo.png":
		name, contentType = route, "image/png"
	default:
		http.NotFound(w, r)
		return
	}
	body, err := interfaceFiles.ReadFile("ui/" + name)
	if err != nil {
		http.Error(w, "界面读取失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Write(body)
}

func (a *app) compress(w http.ResponseWriter, r *http.Request) {
	target, err := strconv.Atoi(r.URL.Query().Get("kb"))
	if err != nil || !((target >= minTargetKB && target <= maxTargetKB) || target == 150) {
		http.Error(w, "不支持此压缩档位", http.StatusBadRequest)
		return
	}
	select {
	case a.compressor <- struct{}{}:
		defer func() { <-a.compressor }()
	case <-r.Context().Done():
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImageBytes))
	if err != nil {
		http.Error(w, "读取失败，单张图片上限为 50 MB", http.StatusBadRequest)
		return
	}
	result, err := compress(r.Context(), data, target*1000)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "image/"+result.format)
	w.Write(result.data)
}

func writeZIP(w http.ResponseWriter, r *http.Request) {
	type imageFile struct {
		name string
		data []byte
	}
	const maxFiles = 200
	r.Body = http.MaxBytesReader(w, r.Body, 18<<20)
	parts, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "打包请求无效", http.StatusBadRequest)
		return
	}
	var files []imageFile
	names := make(map[string]bool)
	for {
		part, err := parts.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || len(files) >= maxFiles || part.FormName() != "image" || part.FileName() == "" {
			http.Error(w, "无法读取打包文件", http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(io.LimitReader(part, 85_001))
		if err != nil || len(body) == 0 || len(body) > 85_000 {
			http.Error(w, "打包图片大小无效", http.StatusBadRequest)
			return
		}
		part.Close()
		originalName := safeZIPName(part.FileName())
		name := originalName
		ext := path.Ext(name)
		stem := strings.TrimSuffix(name, ext)
		for i := 2; names[strings.ToLower(name)]; i++ {
			name = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		names[strings.ToLower(name)] = true
		files = append(files, imageFile{name, body})
	}
	if len(files) == 0 {
		http.Error(w, "没有可打包的图片", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	archive := zip.NewWriter(w)
	for _, file := range files {
		entry, err := archive.CreateHeader(&zip.FileHeader{Name: file.name, Method: zip.Store})
		if err != nil {
			return
		}
		if _, err := entry.Write(file.data); err != nil {
			return
		}
	}
	archive.Close()
}

func safeZIPName(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(c rune) rune {
		if unicode.IsControl(c) || strings.ContainsRune(`<>:"/\|?*`, c) {
			return '_'
		}
		return c
	}, name)
	name = strings.Trim(name, " .")
	if name == "" {
		return "image"
	}
	return name
}

func publicKey() ed25519.PublicKey {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(updatePublicKey))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil
	}
	return key
}

func (a *app) checkUpdate(w http.ResponseWriter, r *http.Request) {
	if publicKey() == nil {
		http.Error(w, "此构建未配置更新签名公钥", http.StatusServiceUnavailable)
		return
	}
	candidate, err := update.Check(r.Context(), a.client, a.sources, publicKey())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if update.Newer(candidate.Manifest.Version, version) && update.Newer(candidate.Manifest.Version, fallbackVersion(a.current.Manifest.Version)) {
		a.current = candidate
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Installed string `json:"installed"`
		Available string `json:"available"`
		Published bool   `json:"published"`
	}{version, a.current.Manifest.Version, candidate.Manifest.Version != ""})
}

func fallbackVersion(candidate string) string {
	if candidate == "" {
		return version
	}
	return candidate
}

func (a *app) install(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	candidate := a.current
	if a.updating || candidate.Manifest.Version != r.URL.Query().Get("version") || !update.Newer(candidate.Manifest.Version, version) {
		a.mu.Unlock()
		http.Error(w, "请重新检查更新", http.StatusConflict)
		return
	}
	a.updating = true
	a.mu.Unlock()

	if err := stageUpdate(r.Context(), a.client, a.sources, candidate); err != nil {
		a.mu.Lock()
		a.updating = false
		a.mu.Unlock()
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	a.quit()
}

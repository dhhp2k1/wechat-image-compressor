package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestSavedPreferencesApplyOnNextStart(t *testing.T) {
	file := filepath.Join(t.TempDir(), "profile", "settings.json")
	const host, session = "127.0.0.1:1234", "test-session"
	start := func() *app {
		a := newApp(host, session, func() {})
		a.preferencesFile = file
		return a
	}
	request := func(a *app, method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "http://"+host+"/"+session+"/"+path, strings.NewReader(body))
		req.Header.Set("X-WeChat-Session", session)
		a.ServeHTTP(rec, req)
		return rec
	}
	checkPage := func(a *app, expected ...string) {
		t.Helper()
		page := request(a, http.MethodGet, "", "")
		for _, attr := range expected {
			if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), attr) {
				t.Fatalf("missing %s in startup page, status %d", attr, page.Code)
			}
		}
	}

	a := start()
	checkPage(a, `data-target-kb="75"`, `data-fit-preview="false"`, `data-check-on-start="true"`)
	for _, body := range []string{`{"targetKB":81,"fitPreview":true,"checkOnStart":false}`, `{"targetKB":68,"fitPreview":true,"checkOnStart":false}`} {
		res := request(a, http.MethodPost, "api/settings", body)
		if res.Code != http.StatusNoContent {
			t.Fatalf("save failed: %d %s", res.Code, res.Body.String())
		}
	}
	res := request(a, http.MethodPost, "api/settings", `{"targetKB":86}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid cap was accepted: %d", res.Code)
	}
	checkPage(start(), `data-target-kb="68"`, `data-fit-preview="true"`, `data-check-on-start="false"`)
}

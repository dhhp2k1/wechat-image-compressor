package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

const (
	minTargetKB    = 65
	maxTargetKB    = 85
	maxConfigBytes = 4096
)

type preferences struct {
	TargetKB     int  `json:"targetKB"`
	FitPreview   bool `json:"fitPreview"`
	CheckOnStart bool `json:"checkOnStart"`
}

var defaultPreferences = preferences{TargetKB: 75, CheckOnStart: true}

func preferencesPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "WeChatImageCompressor", "settings.json")
}

func readPreferences(path string) preferences {
	cfg := defaultPreferences
	file, err := os.Open(path)
	if err != nil {
		return cfg
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes || json.Unmarshal(data, &cfg) != nil {
		return defaultPreferences
	}
	if cfg.TargetKB < minTargetKB || cfg.TargetKB > maxTargetKB {
		cfg.TargetKB = defaultPreferences.TargetKB
	}
	return cfg
}

func writePreferences(path string, cfg preferences) error {
	if path == "" {
		return errors.New("configuration folder unavailable")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, "settings-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := errors.Join(json.NewEncoder(temp).Encode(cfg), temp.Sync(), temp.Close()); err != nil {
		return err
	}
	return atomicReplace(temp.Name(), path)
}

func (a *app) savePreferences(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxConfigBytes))
	var cfg preferences
	if err != nil || json.Unmarshal(data, &cfg) != nil || cfg.TargetKB < minTargetKB || cfg.TargetKB > maxTargetKB {
		http.Error(w, "设置无效，请重新选择", http.StatusBadRequest)
		return
	}
	if err := writePreferences(a.preferencesFile, cfg); err != nil {
		http.Error(w, "无法保存设置", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

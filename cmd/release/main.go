package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dhhp2k1/wechat-image-compressor/internal/update"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	switch {
	case len(args) == 2 && args[0] == "keygen":
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(args[1], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, writeErr := fmt.Fprintln(file, base64.StdEncoding.EncodeToString(private.Seed()))
		if err := errors.Join(writeErr, file.Close()); err != nil {
			return err
		}
		fmt.Println(base64.StdEncoding.EncodeToString(public))
		return nil
	case len(args) == 1 && args[0] == "public":
		private, err := privateKey()
		if err != nil {
			return err
		}
		fmt.Println(base64.StdEncoding.EncodeToString(private.Public().(ed25519.PublicKey)))
		return nil
	case len(args) == 4 && args[0] == "sign":
		return sign(args[1], args[2], args[3])
	default:
		return errors.New("usage: release keygen <private-key-file> | public | sign <vX.Y.Z> <exe> <manifest>")
	}
}

func privateKey() (ed25519.PrivateKey, error) {
	seed := os.Getenv("WIC_UPDATE_PRIVATE_KEY")
	if path := os.Getenv("WIC_UPDATE_KEY_FILE"); seed == "" && path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		seed = string(raw)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(seed))
	if err != nil || len(raw) != ed25519.SeedSize {
		return nil, errors.New("valid release key required in WIC_UPDATE_PRIVATE_KEY or WIC_UPDATE_KEY_FILE")
	}
	return ed25519.NewKeyFromSeed(raw), nil
}

func sign(version, executable, manifestPath string) error {
	private, err := privateKey()
	if err != nil {
		return err
	}
	file, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, update.MaxAssetSize+1))
	if err != nil {
		return err
	}
	m, err := update.Sign(update.Release{
		Version: version,
		Asset:   filepath.Base(executable),
		Size:    size,
		SHA256:  hex.EncodeToString(hash.Sum(nil)),
	}, private)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestPath, append(data, '\n'), 0644)
}

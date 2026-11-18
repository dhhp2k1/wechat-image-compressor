package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/dhhp2k1/wechat-image-compressor/internal/update"
)

const appTitle = "微信图片轻压缩"
const updateTempPrefix = "wechat-compressor-update-"

var (
	messageBox   = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	shellOpen    = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
	kernel32     = syscall.NewLazyDLL("kernel32.dll")
	moveFileExW  = kernel32.NewProc("MoveFileExW")
	createMutexW = kernel32.NewProc("CreateMutexW")
	releaseMutex = kernel32.NewProc("ReleaseMutex")
)

func main() {
	args := os.Args[1:]
	if len(args) == 4 && args[0] == "--apply-update" {
		if err := applyUpdate(args[1], args[2], args[3]); err != nil {
			showError("更新未完成。\n" + err.Error())
		}
		return
	}
	if len(args) == 3 && args[0] == "--clean-update" {
		go cleanUpdate(args[1], args[2])
	}
	if err := runWindow(); err != nil {
		showError(err.Error())
	}
}

func runWindow() error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("无法启动程序：%w", err)
	}
	defer listener.Close()
	host := listener.Addr().String()
	token := hex.EncodeToString(randBytes(24))
	quit := make(chan struct{})
	stop := sync.OnceFunc(func() { close(quit) })
	server := &http.Server{
		Handler: newApp(host, token, stop), ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout: 45 * time.Second, MaxHeaderBytes: 32 << 10,
	}
	go server.Serve(listener)
	window, profile, err := openWindow("http://" + host + "/" + token + "/")
	if err != nil {
		server.Close()
		return err
	}
	var closed chan struct{}
	if window != nil {
		closed = make(chan struct{})
		go func() {
			window.Wait()
			close(closed)
			stop()
		}()
		defer os.RemoveAll(profile)
	}
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if server.Shutdown(ctx) != nil {
		server.Close()
	}
	if window != nil {
		window.Process.Kill()
		<-closed
	}
	return nil
}

func randBytes(size int) []byte {
	data := make([]byte, size)
	rand.Read(data)
	return data
}

func openWindow(address string) (*exec.Cmd, string, error) {
	for _, root := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
		if root == "" {
			continue
		}
		edge := filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe")
		if _, err := os.Stat(edge); err != nil {
			continue
		}
		profile, err := os.MkdirTemp("", "wechat-compressor-window-")
		if err != nil {
			break
		}
		cmd := exec.Command(edge, "--app="+address, "--user-data-dir="+profile, "--window-size=1140,800",
			"--no-first-run", "--no-default-browser-check", "--disable-background-mode", "--disable-sync")
		if err := cmd.Start(); err == nil {
			return cmd, profile, nil
		}
		os.RemoveAll(profile)
	}
	target, _ := syscall.UTF16PtrFromString(address + "?tab=1")
	result, _, _ := shellOpen.Call(0, 0, uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if result <= 32 {
		return nil, "", errors.New("无法打开应用窗口")
	}
	return nil, "", nil
}

func showError(message string) {
	body, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString(appTitle)
	messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x10010)
}

func stageUpdate(ctx context.Context, client *http.Client, sources []update.Source, candidate update.Candidate) error {
	target, err := os.Executable()
	if err != nil {
		return err
	}
	target, err = filepath.EvalSymlinks(target)
	if err != nil {
		return err
	}
	// Check write access before downloading and closing the application.
	probe, err := os.CreateTemp(filepath.Dir(target), ".wechat-write-test-")
	if err != nil {
		return errors.New("无法写入程序所在文件夹")
	}
	probe.Close()
	os.Remove(probe.Name())
	dir, err := os.MkdirTemp("", updateTempPrefix)
	if err != nil {
		return err
	}
	started := false
	defer func() {
		if !started {
			os.RemoveAll(dir)
		}
	}()
	payload, err := update.Download(ctx, client, sources, candidate, dir)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(candidate.Manifest)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, update.ManifestName), data, 0600); err != nil {
		return err
	}
	helper := filepath.Join(dir, "update-helper.exe")
	if err := copyFile(helper, target); err != nil {
		return err
	}
	cmd := exec.Command(helper, "--apply-update", strconv.Itoa(os.Getpid()), target, filepath.Base(payload))
	if err := cmd.Start(); err != nil {
		return err
	}
	started = true
	cmd.Process.Release()
	return nil
}

func applyUpdate(parent, target, payloadName string) error {
	helper, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Dir(helper)
	if !validUpdateDir(dir) || filepath.Base(payloadName) != payloadName || !filepath.IsAbs(target) ||
		!strings.EqualFold(filepath.Ext(target), ".exe") {
		return errors.New("更新位置无效")
	}
	if err := waitForProcess(parent, 25*time.Second); err != nil {
		return err
	}
	unlock, err := lockUpdate(target)
	if err != nil {
		return err
	}
	defer unlock()
	oldDigest, err := digestFile(helper)
	if err != nil {
		return err
	}
	got, err := digestFile(target)
	if err != nil || got != oldDigest {
		return errors.New("程序文件已经变更")
	}
	cleanupArgs := []string{"--clean-update", dir, strconv.Itoa(os.Getpid())}
	if err := replaceAndRestart(dir, target, payloadName, cleanupArgs); err != nil {
		if restartErr := launch(target, cleanupArgs...); restartErr != nil {
			return errors.Join(err, restartErr)
		}
		return err
	}
	return nil
}

func replaceAndRestart(dir, target, payloadName string, args []string) error {
	data, err := os.ReadFile(filepath.Join(dir, update.ManifestName))
	if err != nil {
		return err
	}
	manifest, err := update.Parse(data, publicKey())
	if err != nil {
		return err
	}
	if !update.Newer(manifest.Version, version) {
		return errors.New("更新版本无效")
	}
	payload, err := os.Open(filepath.Join(dir, payloadName))
	if err != nil {
		return err
	}
	defer payload.Close()
	replacement, err := os.CreateTemp(filepath.Dir(target), ".wechat-replacement-*.exe")
	if err != nil {
		return err
	}
	defer os.Remove(replacement.Name())
	verifyErr := manifest.CopyVerified(replacement, payload)
	if err := errors.Join(verifyErr, replacement.Sync(), replacement.Close()); err != nil {
		return err
	}
	backup, err := os.CreateTemp(filepath.Dir(target), ".wechat-backup-*.exe")
	if err != nil {
		return err
	}
	keepBackup := false
	defer func() {
		if !keepBackup {
			os.Remove(backup.Name())
		}
	}()
	if err := backup.Close(); err != nil {
		return err
	}
	if err := copyFile(backup.Name(), target); err != nil {
		return err
	}
	if err := atomicReplace(replacement.Name(), target); err != nil {
		return fmt.Errorf("无法替换程序文件：%w", err)
	}
	if err := launch(target, args...); err != nil {
		if rollback := atomicReplace(backup.Name(), target); rollback != nil {
			keepBackup = true
			return fmt.Errorf("无法重启，旧版本已备份到 %s：%w", backup.Name(), errors.Join(err, rollback))
		}
		return fmt.Errorf("无法重启更新后的版本：%w", err)
	}
	return nil
}

func launch(target string, args ...string) error {
	cmd := exec.Command(target, args...)
	cmd.Dir = filepath.Dir(target)
	if err := cmd.Start(); err != nil {
		return err
	}
	cmd.Process.Release()
	return nil
}

func atomicReplace(source, target string) error {
	from, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	// MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
	result, _, err := moveFileExW.Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), 0x9)
	if result == 0 {
		return err
	}
	return nil
}

func lockUpdate(target string) (func(), error) {
	digest := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(target))))
	name, _ := syscall.UTF16PtrFromString(`Local\WeChatImageCompressor-` + hex.EncodeToString(digest[:]))
	raw, _, err := createMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if raw == 0 {
		return nil, err
	}
	handle := syscall.Handle(raw)
	runtime.LockOSThread()
	status, waitErr := syscall.WaitForSingleObject(handle, 5000)
	const waitAbandoned = 0x80
	if waitErr != nil || (status != syscall.WAIT_OBJECT_0 && status != waitAbandoned) {
		syscall.CloseHandle(handle)
		runtime.UnlockOSThread()
		return nil, errors.New("另一个更新正在进行")
	}
	return func() {
		releaseMutex.Call(raw)
		syscall.CloseHandle(handle)
		runtime.UnlockOSThread()
	}, nil
}

func copyFile(target, source string) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, src)
	return errors.Join(err, out.Sync(), out.Close())
}

func digestFile(path string) ([32]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return [32]byte{}, err
	}
	defer file.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, io.LimitReader(file, update.MaxAssetSize+1))
	return [32]byte(hash.Sum(nil)), err
}

func waitForProcess(raw string, timeout time.Duration) error {
	pid, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || pid == 0 {
		return errors.New("无法识别旧版本进程")
	}
	process, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, syscall.Errno(87)) { // ERROR_INVALID_PARAMETER: process has already exited.
		return nil
	}
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)
	event, err := syscall.WaitForSingleObject(process, uint32(timeout/time.Millisecond))
	if err != nil {
		return err
	}
	if event != syscall.WAIT_OBJECT_0 {
		return errors.New("等待旧版本退出超时")
	}
	return nil
}

func validUpdateDir(dir string) bool {
	return filepath.IsAbs(dir) && strings.HasPrefix(filepath.Base(dir), updateTempPrefix) &&
		strings.EqualFold(filepath.Dir(filepath.Clean(dir)), filepath.Clean(os.TempDir()))
}

func cleanUpdate(dir, pid string) {
	if validUpdateDir(dir) && waitForProcess(pid, 30*time.Second) == nil {
		os.RemoveAll(dir)
	}
}

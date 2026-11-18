# 微信图片轻压缩

[下载 Windows 便携版](https://github.com/dhhp2k1/wechat-image-compressor/releases/latest/download/WeChatImageCompressor-windows-amd64.exe)

在 Windows 10/11 x64 上双击 EXE。程序用 Edge 应用窗口显示界面，图片由 Go 在本机压缩。图片处理可以离线使用。

- 拖入或选择 JPG、PNG、WebP 即开始压缩。粘贴可以连续入队，再统一压缩。
- 默认上限为 75 KB。打开对比可以将上限调至 65–85 KB，或单独生成 150 KB 版。
- 对比窗口按原图比例联动滚动，也可切换适应窗口。支持保存单张或打包当前版本为 ZIP。
- 启动时只显示选图和粘贴，添加图片后打开结果区。
- 在右上角「⋯ → 设置」可调整新图片的压缩上限、对比打开方式和启动时检查更新。设置保存在当前 Windows 用户下。
- 体积按十进制计算。原图符合上限时保留其格式和原始字节，其他输出为 JPEG，透明区域合成白底。压缩动画 WebP 时输出首帧。

## 更新

应用默认在启动后后台检查，也可在右上角「⋯」菜单手动检查。新版发布到 GitHub Release 后，选“下载并重启”即可替换当前 EXE。请把 EXE 放在你有写权限的文件夹。

GitHub 和备用镜像采用同一份发布清单。程序使用内置 Ed25519 公钥验证清单，并检查 EXE 的 SHA-256 和字节数。镜像也可以指向自己的 HTTPS 地址。若设置 Windows 用户环境变量 `WECHAT_UPDATE_MIRROR`，其目录结构为：

```text
<HTTPS 基址>/latest/download/update-windows-amd64.json
<HTTPS 基址>/download/<版本>/WeChatImageCompressor-windows-amd64.exe
```

同步到自有镜像时先上传版本化 EXE，再覆盖最新清单。

## 构建与发布

使用 Go 1.26，在 Windows x64 的 PowerShell 中运行：

```powershell
$env:CGO_ENABLED = '0'
go test ./...
go build -trimpath -ldflags '-s -w -H windowsgui' -o WeChatImageCompressor-windows-amd64.exe .
```

仓库中的 `update-key.pub` 是更新签名公钥。发布私钥保存在仓库之外，`WIC_UPDATE_KEY_FILE` 指向本地私钥文件。推送标签后，GitHub Actions 会独立测试和构建 Windows EXE。发布时在本机签名，再上传 EXE 和清单。

```powershell
$version = 'v2.0.3'
./scripts/build-release.ps1 $version
git tag $version
git push origin "refs/tags/$version"
gh release create $version dist/WeChatImageCompressor-windows-amd64.exe dist/update-windows-amd64.json --verify-tag --latest --generate-notes
```

使用已推送到仓库的干净提交构建并打标签。发布需要 GitHub CLI 登录本仓库。默认构建版本为 v2.0.2，发布脚本会注入指定版本。

修改 Logo 后运行 `node scripts/make-logo.cjs`，再运行 `go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -ico assets/logo.ico -o resource_windows_amd64.syso` 更新 EXE 图标资源。

## 浏览器版 v1.1

见 [v1.1 便携版](./WeChatImageCompressor_portable.html) 和 [v1.1 使用说明](./使用说明.md)。

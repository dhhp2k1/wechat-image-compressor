#Requires -Version 7.3
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string] $Version
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$env:CGO_ENABLED = '0'
$env:GOARCH = 'amd64'

Push-Location (Join-Path $PSScriptRoot '..')
try {
    $public = go run ./cmd/release public
    if ($public -cne (Get-Content -Raw update-key.pub).Trim()) {
        throw 'Release key does not match the embedded public key'
    }
    go mod verify
    go test ./...
    $exe = 'dist/WeChatImageCompressor-windows-amd64.exe'
    go build -buildvcs=false -trimpath -ldflags "-s -w -H windowsgui -X main.version=$Version" -o $exe .
    go run ./cmd/release sign $Version $exe dist/update-windows-amd64.json
}
finally {
    Pop-Location
}

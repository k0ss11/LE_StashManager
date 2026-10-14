<#
.SYNOPSIS
  Install or update LE StashManager from the latest GitHub release.

  One line (PowerShell):
    irm https://raw.githubusercontent.com/k0ss11/LE_StashManager/main/install.ps1 | iex

  Prefer to read it first? Download this file, look at it, then: powershell -ExecutionPolicy Bypass -File install.ps1

  What it does: downloads the release zip from GitHub, checks its SHA-256, extracts it to
  Documents\LE_StashManager (or -Dir), keeps your data/ and config.json when updating, then runs setup.ps1.
  Source only: the zip contains no executables.

.PARAMETER Dir      install folder (default: Documents\LE_StashManager)
.PARAMETER Version  release tag to install, e.g. v0.2.0 (default: latest)
.PARAMETER ZipPath  install from a local zip instead of downloading (testing)
#>
param(
    [string]$Dir = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'LE_StashManager'),
    [string]$Version = 'latest',
    [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$Repo = 'k0ss11/LE_StashManager'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say "LE StashManager installer`n" 'Cyan'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("lesm_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    # ------------------------------------------------------------ download + verify
    if ($ZipPath) {
        $zip = (Resolve-Path $ZipPath).Path
        Say "using local zip $zip"
    } else {
        $api = if ($Version -eq 'latest') { "https://api.github.com/repos/$Repo/releases/latest" }
               else { "https://api.github.com/repos/$Repo/releases/tags/$Version" }
        # optional: $env:GITHUB_TOKEN for a private fork/repo (public releases need no token)
        $hdr = @{ 'User-Agent' = 'LE_StashManager-installer' }
        if ($env:GITHUB_TOKEN) { $hdr['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
        $rel = Invoke-RestMethod -Uri $api -Headers $hdr
        $zipAsset = $rel.assets | Where-Object { $_.name -like 'LE_StashManager-*.zip' } | Select-Object -First 1
        $shaAsset = $rel.assets | Where-Object { $_.name -like 'LE_StashManager-*.zip.sha256' } | Select-Object -First 1
        if (-not $zipAsset -or -not $shaAsset) { throw "release $($rel.tag_name) has no zip/sha256 assets" }
        Say "release $($rel.tag_name): downloading $($zipAsset.name) ..."
        function Get-Asset($asset, $out) {
            if ($env:GITHUB_TOKEN) {  # private: the API asset URL with octet-stream works with a token
                $h = $hdr.Clone(); $h['Accept'] = 'application/octet-stream'
                Invoke-WebRequest -Uri $asset.url -Headers $h -OutFile $out -UseBasicParsing
            } else {
                Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing
            }
        }
        $zip = Join-Path $tmp $zipAsset.name
        Get-Asset $zipAsset $zip
        $shaFile = Join-Path $tmp $shaAsset.name
        Get-Asset $shaAsset $shaFile
        $expected = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
        if ($expected -ne $actual) { throw "SHA-256 mismatch: expected $expected, got $actual - download corrupted or tampered" }
        Say "SHA-256 ok" 'Green'
    }

    # ------------------------------------------------------------ extract
    $ex = Join-Path $tmp 'x'
    Expand-Archive -Path $zip -DestinationPath $ex -Force
    $src = Get-ChildItem $ex -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'host.py'))) { throw 'unexpected zip layout' }

    # ------------------------------------------------------------ install / update (keep user data)
    $update = Test-Path (Join-Path $Dir 'host.py')
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $keep = @('data', '.venv', 'config.json')
    Get-ChildItem $src.FullName -Force | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
        Copy-Item $_.FullName -Destination $Dir -Recurse -Force
    }
    Say ($(if ($update) { "updated" } else { "installed" }) + " in $Dir") 'Green'

    # ------------------------------------------------------------ setup
    Say "`nrunning setup ..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'setup.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'setup failed (see above)' }

    Say "`nStart it with: $Dir\run.bat" 'Cyan'
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

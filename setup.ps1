<#
.SYNOPSIS
  StashManager setup: checks prerequisites, creates a local Python environment, finds Last Epoch,
  checks the game build against the tested builds and writes config.json.

.EXAMPLE
  .\setup.ps1                 # normal setup
  .\setup.ps1 -Icons          # also install UnityPy (needed only for tools\extract_icons.py)
  .\setup.ps1 -GamePath "D:\SteamLibrary\steamapps\common\Last Epoch"
#>
param(
    [string]$GamePath,
    [switch]$Icons
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$MinPython = [version]'3.11'

function Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[fail] $msg" -ForegroundColor Red; exit 1 }

Write-Host "StashManager setup`n"

# ---------------------------------------------------------------- Python
$py = $null
foreach ($cand in @(@('py', '-3'), @('python'))) {
    try {
        $v = & $cand[0] $cand[1..9] -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v) { $py = $cand; break }
    } catch {}
}
if (-not $py) { Fail "Python not found. Install Python $MinPython+ from https://www.python.org/downloads/ (tick 'Add to PATH')." }
if ([version]$v -lt $MinPython) { Fail "Python $v found, need $MinPython+." }
Ok "Python $v"

# ---------------------------------------------------------------- virtual environment + packages
$venv = Join-Path $Root '.venv'
$vpy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $vpy)) {
    & $py[0] $py[1..9] -m venv $venv
    if ($LASTEXITCODE -ne 0) { Fail 'could not create .venv' }
}
Ok "virtual environment: .venv"

& $vpy -m pip install --disable-pip-version-check -q --upgrade pip
& $vpy -m pip install --disable-pip-version-check -q -r (Join-Path $Root 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Fail 'pip install failed (see output above)' }
if ($Icons) {
    & $vpy -m pip install --disable-pip-version-check -q -r (Join-Path $Root 'requirements-icons.txt')
    if ($LASTEXITCODE -ne 0) { Fail 'pip install of icon tools failed' }
}
$fridaV = & $vpy -c "import frida; print(frida.__version__)"
Ok "frida $fridaV (from PyPI)"
if ($Icons) { Ok ("UnityPy " + (& $vpy -c "import UnityPy; print(UnityPy.__version__)")) }

# ---------------------------------------------------------------- Node (optional)
try { $nodeV = (& node --version) 2>$null } catch { $nodeV = $null }
if ($nodeV) { Ok "Node $nodeV (optional: tools\apply_preset.js)" } else { Warn 'Node not found - only needed for tools\apply_preset.js (the web page does not need it)' }

# ---------------------------------------------------------------- find the game
function Find-Game {
    $steam = $null
    foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam') {
        try {
            $p = Get-ItemProperty -Path $key -ErrorAction Stop
            $steam = if ($p.SteamPath) { $p.SteamPath } else { $p.InstallPath }
            if ($steam) { break }
        } catch {}
    }
    if (-not $steam) { return $null }
    $libs = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        Select-String -Path $vdf -Pattern '"path"\s+"([^"]+)"' | ForEach-Object { $libs += $_.Matches[0].Groups[1].Value -replace '\\\\', '\' }
    }
    foreach ($lib in $libs | Select-Object -Unique) {
        $g = Join-Path $lib 'steamapps\common\Last Epoch'
        if (Test-Path (Join-Path $g 'Last Epoch.exe')) { return $g }
    }
    return $null
}

if (-not $GamePath) { $GamePath = Find-Game }
if (-not $GamePath -or -not (Test-Path (Join-Path $GamePath 'Last Epoch.exe'))) {
    Fail 'Last Epoch not found. Re-run with: .\setup.ps1 -GamePath "<folder containing Last Epoch.exe>"'
}
Ok "game: $GamePath"

# ---------------------------------------------------------------- game build check
$hashFile = Join-Path $GamePath 'Last Epoch_Data\build_hash.txt'
$build = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { 'unknown' }
$supported = Get-Content (Join-Path $Root 'supported_builds.json') -Raw | ConvertFrom-Json
$match = $supported.builds | Where-Object { $_.buildHash -eq $build }
if ($match) {
    Ok "game build $($build.Substring(0,10)) is tested ($($match.label))"
} else {
    Warn "game build $($build.Substring(0, [Math]::Min(10, $build.Length))) is NOT in supported_builds.json."
    Warn 'Most lookups are by name and usually survive patches. Try it with the stash open; if something fails,'
    Warn 'run .venv\Scripts\python tools\dev\crud_test.py (no gold spent) and report the output.'
}

# ---------------------------------------------------------------- config
$config = [ordered]@{ gamePath = $GamePath; buildHash = $build; setupAt = (Get-Date).ToString('s') }
$config | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Root 'config.json')
Ok 'wrote config.json'

Write-Host "`nDone. Next:"
Write-Host '  1. Start Last Epoch and load your character.'
Write-Host '  2. Run run.bat  (opens http://127.0.0.1:8100)'
if ($Icons) { Write-Host '  3. Optional, once per game patch: .venv\Scripts\python tools\extract_icons.py' }
Write-Host "`nRead README.md 'Safety' before using it online."

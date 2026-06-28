param(
    [string]$Version = "",
    [switch]$ZipOnly,
    [switch]$Prerelease
)
$ErrorActionPreference = "Continue"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --- Paths ---
$repoRoot   = Split-Path -Parent $PSScriptRoot
$extDir     = Join-Path $repoRoot "extension"
$daemonDir  = Join-Path $repoRoot "daemon"
$docsDir    = Join-Path $repoRoot "docs"
$installer  = Join-Path $repoRoot "installer"
$buildDir   = Join-Path $repoRoot "build"
$manifest   = Join-Path $extDir "manifest.json"
$versionFile= Join-Path $repoRoot "VERSION"

if (-not $Version) {
    $m = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = $m.version
}
$tag = "v$Version"

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "  ARAD Bridge - Release Builder" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "  Version: $tag" -ForegroundColor White
Write-Host ""

# Sync VERSION file with manifest
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($versionFile, "$Version`n", $utf8NoBom)
Write-Host "  [OK] VERSION file synced to $Version" -ForegroundColor Green

# --- Truncation guard ---
# Detect files on disk smaller than HEAD (silent corruption). If we skip this,
# a broken file gets zipped into the release and breaks every install.
Write-Host "  Checking for truncated files vs git HEAD..." -ForegroundColor Yellow
# Previously: 10% tolerance — failed to catch 487-byte truncation in install.ps1 (1.5%).
# New rule: scan ALL tracked files. Any working-tree file more than 50 bytes
# smaller than its HEAD version is treated as truncated and aborts the release.
# (50 bytes covers trailing-whitespace / newline differences without ever
# missing a real cut.)
Push-Location $repoRoot
$truncated = @()
$tracked = git ls-tree -r --name-only HEAD 2>$null
foreach ($f in $tracked) {
    if (-not (Test-Path $f)) { continue }
    # Skip binary-ish files where text comparison is noisy
    if ($f -match '\.(png|jpg|jpeg|gif|ico|zip|pdf)$') { continue }
    $diskSize = (Get-Item $f).Length
    $headBytes = git show "HEAD:$f" 2>$null | Out-String
    $headSize = $headBytes.Length
    if ($headSize -gt 0 -and ($headSize - $diskSize) -gt 50) {
        $truncated += ('{0} (disk={1}, HEAD={2}, missing={3})' -f $f, $diskSize, $headSize, ($headSize - $diskSize))
    }
}
Pop-Location
if ($truncated.Count -gt 0) {
    Write-Host "  [X] TRUNCATION DETECTED - aborting:" -ForegroundColor Red
    foreach ($t in $truncated) { Write-Host ("      " + $t) -ForegroundColor Red }
    Write-Host "  Recover with: git checkout HEAD -- PATH" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] No truncated files" -ForegroundColor Green

# --- Prep staging dir ---
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
}
$stage = Join-Path $buildDir "arad-bridge-$tag"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# --- Copy files into staging ---
Write-Host "  Staging files..." -ForegroundColor Yellow
Copy-Item $extDir     "$stage\extension" -Recurse -Force
Copy-Item $daemonDir  "$stage\daemon"    -Recurse -Force
Copy-Item $installer  "$stage\installer" -Recurse -Force
if (Test-Path $docsDir) {
    Copy-Item $docsDir "$stage\docs" -Recurse -Force
}

$rootFiles = @('install.bat', 'uninstall.bat', 'README.md', 'VERSION')
foreach ($f in $rootFiles) {
    $src = Join-Path $repoRoot $f
    if (Test-Path $src) {
        Copy-Item $src $stage -Force
    } else {
        Write-Host ("  [!] missing root file: " + $f) -ForegroundColor Yellow
    }
}

# Filter out artifacts
Get-ChildItem $stage -Recurse -Force -Directory |
    Where-Object { $_.Name -in @('.git', 'node_modules', '__pycache__', 'build') } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$profileDir = Join-Path $stage "daemon\profile"
if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force }

# --- Build ZIP ---
$zipPath = Join-Path $buildDir ("arad-bridge-" + $tag + ".zip")
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Write-Host "  Creating ZIP..." -ForegroundColor Yellow
Compress-Archive -Path "$stage\*" -DestinationPath $zipPath -Force
$sizeKB = [math]::Round((Get-Item $zipPath).Length / 1024, 1)
Write-Host ("  [OK] ZIP: " + $zipPath + " (" + $sizeKB + " KB)") -ForegroundColor Green

Remove-Item $stage -Recurse -Force

if ($ZipOnly) {
    Write-Host ""
    Write-Host ("DONE (ZIP-only mode). File at: " + $zipPath) -ForegroundColor Green
    return
}

# --- Push to origin ---
Push-Location $repoRoot
Write-Host "  Pushing repo to origin..." -ForegroundColor Yellow
git push --set-upstream origin HEAD 2>&1 | Out-Null
Write-Host "  [OK] Repo synced" -ForegroundColor Green

# --- GitHub release (idempotent) ---
Write-Host ("  Creating GitHub release " + $tag + "...") -ForegroundColor Yellow
gh release delete $tag --yes 2>$null | Out-Null

$releaseArgs = @($tag, $zipPath, '--title', $tag, '--notes', ("Release " + $tag + " - ARAD Bridge"))
if ($Prerelease) { $releaseArgs += '--prerelease' }

gh release create @releaseArgs
$exit = $LASTEXITCODE
Pop-Location

Write-Host ""
if ($exit -eq 0) {
    Write-Host "===============================================" -ForegroundColor Green
    Write-Host "  DONE!" -ForegroundColor Green
    Write-Host "===============================================" -ForegroundColor Green
    Write-Host ("  Visit: https://github.com/liorgab/arad-bridge/releases/tag/" + $tag) -ForegroundColor Cyan
} else {
    Write-Host ("  [X] gh release create failed (exit " + $exit + ")") -ForegroundColor Red
    Write-Host ("  ZIP still available at: " + $zipPath) -ForegroundColor Yellow
}

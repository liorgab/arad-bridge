param(
    [string]$Version = "",
    [switch]$ZipOnly,           # Build ZIP only, don't push or release
    [switch]$Prerelease
)
$ErrorActionPreference = "Continue"

# ─── Paths ───────────────────────────────────────────────────────────
$repoRoot   = Split-Path -Parent $PSScriptRoot
$extDir     = Join-Path $repoRoot "extension"
$daemonDir  = Join-Path $repoRoot "daemon"
$docsDir    = Join-Path $repoRoot "docs"
$installer  = Join-Path $repoRoot "installer"
$buildDir   = Join-Path $repoRoot "build"
$manifest   = Join-Path $extDir "manifest.json"
$versionFile= Join-Path $repoRoot "VERSION"

# ─── Resolve version (manifest is source of truth) ──────────────────
if (-not $Version) {
    $m = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = $m.version
}
$tag = "v$Version"

Write-Host ""
Write-Host "═══════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ARAD Bridge - Release Builder" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Version: $tag" -ForegroundColor White
Write-Host ""

# ─── Sync VERSION file with manifest ────────────────────────────────
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($versionFile, "$Version`n", $utf8NoBom)
Write-Host "  [OK] VERSION file synced to $Version" -ForegroundColor Green

# ─── Prep staging dir (clean) ───────────────────────────────────────
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir -Force | Out-Null }
$stage = Join-Path $buildDir "arad-bridge-$tag"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# ─── Copy everything user-facing into staging ───────────────────────
Write-Host "  Staging files..." -ForegroundColor Yellow
Copy-Item $extDir     "$stage\extension" -Recurse -Force
Copy-Item $daemonDir  "$stage\daemon"    -Recurse -Force
Copy-Item $installer  "$stage\installer" -Recurse -Force
if (Test-Path $docsDir) {
    Copy-Item $docsDir "$stage\docs" -Recurse -Force
}

# Root files that the installer expects
$rootFiles = @('install.bat', 'README.md', 'VERSION')
foreach ($f in $rootFiles) {
    $src = Join-Path $repoRoot $f
    if (Test-Path $src) {
        Copy-Item $src $stage -Force
    } else {
        Write-Host "  [!] missing root file: $f" -ForegroundColor Yellow
    }
}

# Filter out build/.git/node_modules artifacts that may have been copied recursively
Get-ChildItem $stage -Recurse -Force -Directory |
    Where-Object { $_.Name -in @('.git', 'node_modules', '__pycache__', 'build') } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Filter out chrome profile leftovers in daemon (if any)
$profileDir = Join-Path $stage "daemon\profile"
if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force }

# ─── Build ZIP ──────────────────────────────────────────────────────
$zipPath = Join-Path $buildDir "arad-bridge-$tag.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Write-Host "  Creating ZIP..." -ForegroundColor Yellow
Compress-Archive -Path "$stage\*" -DestinationPath $zipPath -Force
$sizeKB = [math]::Round((Get-Item $zipPath).Length / 1024, 1)
Write-Host "  [OK] ZIP: $zipPath ($sizeKB KB)" -ForegroundColor Green

# Cleanup staging dir
Remove-Item $stage -Recurse -Force

if ($ZipOnly) {
    Write-Host ""
    Write-Host "DONE (ZIP-only mode). File at: $zipPath" -ForegroundColor Green
    return
}

# ─── Sync repo to origin ────────────────────────────────────────────
Push-Location $repoRoot
Write-Host "  Pushing repo to origin..." -ForegroundColor Yellow
git push origin HEAD 2>&1 | Out-Null
Write-Host "  [OK] Repo synced" -ForegroundColor Green

# ─── Create GitHub release (idempotent) ─────────────────────────────
Write-Host "  Creating GitHub release $tag..." -ForegroundColor Yellow
gh release delete $tag --yes 2>$null | Out-Null

$releaseArgs = @($tag, $zipPath, '--title', $tag, '--notes', "Release $tag - ARAD Bridge")
if ($Prerelease) { $releaseArgs += '--prerelease' }

gh release create @releaseArgs
$exit = $LASTEXITCODE
Pop-Location

Write-Host ""
if ($exit -eq 0) {
    Write-Host "═══════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  DONE!" -ForegroundColor Green
    Write-Host "═══════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  Visit: https://github.com/liorgab/arad-bridge/releases/tag/$tag" -ForegroundColor Cyan
} else {
    Write-Host "  [X] gh release create failed (exit $exit)" -ForegroundColor Red
    Write-Host "  ZIP still available at: $zipPath" -ForegroundColor Yellow
}

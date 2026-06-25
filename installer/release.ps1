# ====================================================================
#  ARAD Bridge - Create a GitHub Release
# ====================================================================
#  Usage:
#    .\release.ps1                  # auto-bumps patch version
#    .\release.ps1 -Version 2.1.0   # explicit version
#    .\release.ps1 -DryRun          # show what would happen, don't push
#
#  Prerequisites:
#    - gh CLI installed (winget install GitHub.cli)
#    - git authenticated to GitHub (gh auth login)
#    - Run from inside the cloned repo
#
#  What it does:
#    1. Reads version from manifest.json
#    2. Increments patch if not specified (or uses -Version)
#    3. Updates manifest.json with new version
#    4. Commits + pushes the version bump
#    5. Creates a ZIP of the extension/ folder
#    6. Creates a GitHub release with that ZIP attached
#    7. Auto-generates release notes from commits since last tag
# ====================================================================

param(
    [string]$Version = "",
    [string]$Notes = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  ARAD Bridge - Release Builder"           -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# --- Paths ---
$REPO_ROOT  = Split-Path -Parent $PSScriptRoot
$EXT_DIR    = Join-Path $REPO_ROOT "extension"
$MANIFEST   = Join-Path $EXT_DIR "manifest.json"
$BUILD_DIR  = Join-Path $REPO_ROOT "build"

# --- 1. Verify prerequisites ---
Write-Host "[1/7] Verifying prerequisites..." -ForegroundColor Yellow
try {
    $null = Get-Command gh -ErrorAction Stop
    Write-Host "  [OK] gh CLI installed" -ForegroundColor Green
} catch {
    Write-Host "  [X] gh CLI not installed. Run: winget install GitHub.cli" -ForegroundColor Red
    exit 1
}
try {
    $null = Get-Command git -ErrorAction Stop
    Write-Host "  [OK] git installed" -ForegroundColor Green
} catch {
    Write-Host "  [X] git not installed" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $MANIFEST)) {
    Write-Host "  [X] manifest.json not found at $MANIFEST" -ForegroundColor Red
    exit 1
}

# --- 2. Read current version ---
Write-Host ""
Write-Host "[2/7] Reading current version..." -ForegroundColor Yellow
$manifest = Get-Content $MANIFEST -Raw | ConvertFrom-Json
$currentVersion = $manifest.version
Write-Host "  Current: v$currentVersion" -ForegroundColor White

# --- 3. Determine new version ---
if (-not $Version) {
    $parts = $currentVersion.Split('.')
    $parts[$parts.Length - 1] = [int]$parts[$parts.Length - 1] + 1
    $Version = $parts -join '.'
    Write-Host "  New (patch bump): v$Version" -ForegroundColor Green
} else {
    Write-Host "  New (explicit): v$Version" -ForegroundColor Green
}

# --- 4. Update manifest.json ---
Write-Host ""
Write-Host "[3/7] Updating manifest.json..." -ForegroundColor Yellow
if ($DryRun) {
    Write-Host "  [DRY-RUN] Would set version to $Version" -ForegroundColor Magenta
} else {
    $manifest.version = $Version
    $jsonOut = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($MANIFEST, $jsonOut, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  [OK] manifest.json -> v$Version" -ForegroundColor Green
}

# --- 5. Commit + push the version bump ---
Write-Host ""
Write-Host "[4/7] Committing version bump..." -ForegroundColor Yellow
Push-Location $REPO_ROOT
try {
    if ($DryRun) {
        Write-Host "  [DRY-RUN] Would commit + push manifest.json change" -ForegroundColor Magenta
    } else {
        git add $MANIFEST | Out-Null
        $commitMsg = "release: v$Version"
        git commit -m $commitMsg 2>&1 | Out-Null
        git push origin HEAD 2>&1 | Out-Null
        Write-Host "  [OK] Pushed: $commitMsg" -ForegroundColor Green
    }
} finally {
    Pop-Location
}

# --- 6. Build ZIP ---
Write-Host ""
Write-Host "[5/7] Building ZIP..." -ForegroundColor Yellow
if (-not (Test-Path $BUILD_DIR)) {
    New-Item -ItemType Directory -Path $BUILD_DIR -Force | Out-Null
}
$zipName = "arad-bridge-v$Version.zip"
$zipPath = Join-Path $BUILD_DIR $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

if ($DryRun) {
    Write-Host "  [DRY-RUN] Would create: $zipPath" -ForegroundColor Magenta
} else {
    Compress-Archive -Path "$EXT_DIR\*" -DestinationPath $zipPath -Force
    $sizeKB = [math]::Round((Get-Item $zipPath).Length / 1024, 1)
    Write-Host "  [OK] $zipName ($sizeKB KB)" -ForegroundColor Green
}

# --- 7. Generate release notes if not provided ---
Write-Host ""
Write-Host "[6/7] Generating release notes..." -ForegroundColor Yellow
if (-not $Notes) {
    Push-Location $REPO_ROOT
    try {
        $lastTag = git describe --tags --abbrev=0 2>$null
        if ($lastTag) {
            $commits = git log "$lastTag..HEAD" --pretty=format:"- %s" 2>$null
        } else {
            $commits = git log --pretty=format:"- %s" -n 10 2>$null
        }
        if ($commits) {
            $Notes = "## What's Changed`n`n$commits`n`n---`n_Auto-generated by release.ps1_"
        } else {
            $Notes = "Release v$Version"
        }
    } finally {
        Pop-Location
    }
}
Write-Host "  [OK] Notes ready ($($Notes.Length) chars)" -ForegroundColor Green

# --- 8. Create GitHub release ---
Write-Host ""
Write-Host "[7/7] Creating GitHub release..." -ForegroundColor Yellow
$tag = "v$Version"

if ($DryRun) {
    Write-Host "  [DRY-RUN] Would run:" -ForegroundColor Magenta
    Write-Host "    gh release create $tag $zipPath --title `"$tag`" --notes <generated>" -ForegroundColor Gray
} else {
    Push-Location $REPO_ROOT
    try {
        $notesFile = New-TemporaryFile
        Set-Content -Path $notesFile.FullName -Value $Notes -NoNewline
        gh release create $tag $zipPath --title $tag --notes-file $notesFile.FullName
        Remove-Item $notesFile.FullName -Force
        $releaseUrl = gh release view $tag --json url --jq '.url'
        Write-Host "  [OK] Release created: $releaseUrl" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# --- Done ---
Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host "  DONE.  Release v$Version published"        -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Users will see the update banner in popup within 6 hours" -ForegroundColor White
Write-Host "(or immediately on next popup open)" -ForegroundColor Gray
Write-Host ""

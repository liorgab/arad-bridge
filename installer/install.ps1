# ====================================================================
#  ARAD Bridge - Local Install (Developer / GitHub flow)
# ====================================================================

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  ARAD Bridge - Local Install"               -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Locate the extension folder ---
$repoRoot = Split-Path -Parent $PSScriptRoot
$extPath = Join-Path $repoRoot "extension"

Write-Host "[1/4] Validating extension folder..." -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $extPath "manifest.json"))) {
    Write-Host "  [X] manifest.json not found at: $extPath" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Extension folder: $extPath" -ForegroundColor Green

# --- 2. Validate JSON files ---
Write-Host ""
Write-Host "[2/4] Validating JSON files..." -ForegroundColor Yellow
$jsonFiles = Get-ChildItem -Path $extPath -Recurse -Filter "*.json"
$allValid = $true
foreach ($f in $jsonFiles) {
    try {
        $null = Get-Content $f.FullName -Raw | ConvertFrom-Json
        Write-Host "  [OK] $($f.Name)" -ForegroundColor Green
    } catch {
        Write-Host "  [X]  $($f.Name): $_" -ForegroundColor Red
        $allValid = $false
    }
}
if (-not $allValid) { exit 1 }

# --- 3. Inventory modules ---
Write-Host ""
Write-Host "[3/4] Available modules:" -ForegroundColor Yellow
$moduleDirs = Get-ChildItem -Path (Join-Path $extPath "modules") -Directory
foreach ($d in $moduleDirs) {
    $modulePath = Join-Path $d.FullName "module.json"
    if (Test-Path $modulePath) {
        $m = Get-Content $modulePath -Raw | ConvertFrom-Json
        $sku = if ($m.sku) { $m.sku } else { "n/a" }
        $line = "  - {0,-22} ({1}) v{2}" -f $d.Name, $sku, $m.version
        Write-Host $line -ForegroundColor White
    }
}

# --- 4. Open Chrome + copy path to clipboard ---
Write-Host ""
Write-Host "[4/4] Loading in Chrome..." -ForegroundColor Yellow

try {
    $extPath | Set-Clipboard
    Write-Host "  [OK] Extension path copied to clipboard" -ForegroundColor Green
} catch {
    Write-Host "  [!]  Could not copy to clipboard, paste manually:" -ForegroundColor Yellow
    Write-Host "       $extPath" -ForegroundColor White
}

$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromeExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chromeExe) {
    Start-Process -FilePath $chromeExe -ArgumentList "chrome://extensions/"
    Write-Host "  [OK] Chrome opened to chrome://extensions/" -ForegroundColor Green
} else {
    Write-Host "  [!] Chrome not found - open chrome://extensions/ manually" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  NEXT STEPS IN CHROME:" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  1. Toggle 'Developer mode' (top-right corner)" -ForegroundColor White
Write-Host "  2. Click 'Load unpacked'" -ForegroundColor White
Write-Host "  3. Press Ctrl+V to paste the folder path" -ForegroundColor White
Write-Host "  4. Click 'Select Folder'" -ForegroundColor White
Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  THEN TEST HANDSHAKE:" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  1. Open https://arad-admin.vercel.app" -ForegroundColor White
Write-Host "  2. Press F12 to open DevTools, go to Console" -ForegroundColor White
Write-Host "  3. Paste this test command:" -ForegroundColor White
Write-Host ""

# Use here-string for the multi-line JS command (literal, no PS interpretation)
$testCmd = @'
  await window.__aradBridge.handshake({
    customer_id: "test_customer_1",
    app_origin: window.location.origin,
    enabled_modules: ["piba", "hopon", "whatsapp_single"]
  })
'@
Write-Host $testCmd -ForegroundColor Yellow

Write-Host ""
Write-Host "  Expected: success: true, active_modules: [piba, hopon, whatsapp_single]" -ForegroundColor Gray
Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  DONE.  Path is in clipboard." -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# ====================================================================
#  ARAD Bulk Daemon - Install / Update
# ====================================================================
#  Sets up the ARAD WhatsApp Bulk Daemon at:
#    %LOCALAPPDATA%\AradBulkDaemon\
#
#  Strategy: REUSE Python + Chrome for Testing from the existing
#  D.Yohai install (saves ~250MB download). Only adds:
#    - Daemon script (arad_bulk_daemon.py)
#    - Separate ChromeDriver
#    - Separate profile folder (so WhatsApp logins don't conflict)
#    - config.json (paths + port 8766)
#    - Desktop shortcut + auto-start
# ====================================================================

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  ARAD Bulk Daemon - Installer"           -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# --- Paths ---
$ARAD_DIR    = Join-Path $env:LOCALAPPDATA "AradBulkDaemon"
$DYOHAI_DIR  = Join-Path $env:LOCALAPPDATA "Base44BulkSender"
$REPO_ROOT   = Split-Path -Parent $PSScriptRoot
$DAEMON_SRC  = Join-Path $REPO_ROOT "daemon\arad_bulk_daemon.py"

# --- 1. Verify Python is installed (reuse from D.Yohai) ---
Write-Host "[1/7] Verifying Python..." -ForegroundColor Yellow
$pyCandidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "C:\Python313\python.exe",
    "C:\Python312\python.exe",
    "C:\Program Files\Python313\python.exe",
    "C:\Program Files\Python312\python.exe"
)
$pyExe = $pyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pyExe) {
    try { $pyExe = (Get-Command python -ErrorAction Stop).Source } catch {}
}
if (-not $pyExe) {
    Write-Host "  [X] Python not found." -ForegroundColor Red
    Write-Host "      Install Python 3.11+ first (e.g., from D.Yohai installer)." -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Python: $pyExe" -ForegroundColor Green

# Check required packages
$pkgsOk = & $pyExe -c "import selenium, flask, flask_cors, requests, pyperclip; print('OK')" 2>&1
if ($pkgsOk -notmatch "OK") {
    Write-Host "  [!] Installing Python packages..." -ForegroundColor Yellow
    & $pyExe -m pip install --quiet --upgrade selenium flask flask-cors requests pyperclip
}
Write-Host "  [OK] All Python packages present" -ForegroundColor Green

# --- 2. Find Chrome for Testing (reuse from D.Yohai or SeleniumBasic) ---
Write-Host ""
Write-Host "[2/7] Finding Chrome for Testing..." -ForegroundColor Yellow
$chromeCandidates = @(
    (Join-Path $DYOHAI_DIR "chrome-win64\chrome.exe"),
    "$env:LOCALAPPDATA\SeleniumBasic\chrome-win64\chrome.exe",
    "$env:ProgramFiles\Chrome for Testing\chrome.exe",
    "C:\chrome-win64\chrome.exe"
)
$chromeExe = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeExe) {
    Write-Host "  [X] Chrome for Testing not found." -ForegroundColor Red
    Write-Host "      Install D.Yohai first (it includes Chrome for Testing)." -ForegroundColor Red
    Write-Host "      Or download manually from https://googlechromelabs.github.io/chrome-for-testing/" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] Chrome for Testing: $chromeExe" -ForegroundColor Green

# --- 3. Find or copy ChromeDriver ---
Write-Host ""
Write-Host "[3/7] Setting up ChromeDriver..." -ForegroundColor Yellow
$driverCandidates = @(
    (Join-Path $DYOHAI_DIR "chromedriver.exe"),
    "$env:LOCALAPPDATA\SeleniumBasic\chromedriver.exe"
)
$driverSrc = $driverCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $driverSrc) {
    Write-Host "  [X] ChromeDriver not found in D.Yohai or SeleniumBasic." -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] ChromeDriver source: $driverSrc" -ForegroundColor Green

# --- 4. Create ARAD daemon directory + copy files ---
Write-Host ""
Write-Host "[4/7] Setting up $ARAD_DIR..." -ForegroundColor Yellow
if (-not (Test-Path $ARAD_DIR)) {
    New-Item -ItemType Directory -Path $ARAD_DIR -Force | Out-Null
}
$profileDir = Join-Path $ARAD_DIR "profile"
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}

# Copy daemon script
if (-not (Test-Path $DAEMON_SRC)) {
    Write-Host "  [X] arad_bulk_daemon.py not found at $DAEMON_SRC" -ForegroundColor Red
    Write-Host "      Make sure you ran this from inside the cloned arad-bridge repo." -ForegroundColor Red
    exit 1
}
$daemonDst = Join-Path $ARAD_DIR "arad_bulk_daemon.py"
Copy-Item $DAEMON_SRC $daemonDst -Force
Write-Host "  [OK] Daemon copied: $daemonDst" -ForegroundColor Green

# Copy ChromeDriver
$driverDst = Join-Path $ARAD_DIR "chromedriver.exe"
Copy-Item $driverSrc $driverDst -Force
Write-Host "  [OK] ChromeDriver copied" -ForegroundColor Green

# --- 5. Write config.json (reuse Chrome path, separate profile, port 8766) ---
Write-Host ""
Write-Host "[5/7] Writing config.json..." -ForegroundColor Yellow
$configPath = Join-Path $ARAD_DIR "config.json"
$config = @{
    chrome_path   = $chromeExe
    chromedriver  = $driverDst
    profile_dir   = $profileDir
    port          = 8766
} | ConvertTo-Json -Depth 5

# Write without BOM (Python's json.load rejects BOM)
# PS 5.1 + PS 7 compatible: encode to bytes, write bytes
$encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
$bytes = $encoding.GetBytes([string]$config)
[System.IO.File]::WriteAllBytes($configPath, $bytes)
Write-Host "  [OK] config.json written" -ForegroundColor Green
Write-Host "       Port: 8766 (separate from D.Yohai's 8765)" -ForegroundColor Gray
Write-Host "       Profile: $profileDir (separate WA login)" -ForegroundColor Gray

# --- 6. Create desktop + start menu shortcuts ---
Write-Host ""
Write-Host "[6/7] Creating shortcuts..." -ForegroundColor Yellow

# Find pythonw.exe (windowless) - same dir as python.exe
$pyDir = Split-Path -Parent $pyExe
$pywExe = Join-Path $pyDir "pythonw.exe"
if (-not (Test-Path $pywExe)) { $pywExe = $pyExe }  # fallback

$WshShell = New-Object -ComObject WScript.Shell

# Desktop shortcut
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "ARAD Bulk Daemon.lnk"
$s1 = $WshShell.CreateShortcut($desktopShortcut)
$s1.TargetPath       = $pywExe
$s1.Arguments        = "`"$daemonDst`""
$s1.WorkingDirectory = $ARAD_DIR
$s1.Description      = "ARAD Bulk WhatsApp Daemon - localhost:8766"
$s1.WindowStyle      = 7  # minimized
$s1.Save()
Write-Host "  [OK] Desktop: $desktopShortcut" -ForegroundColor Green

# Start Menu shortcut
$startShortcut = Join-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" "ARAD Bulk Daemon.lnk"
$s2 = $WshShell.CreateShortcut($startShortcut)
$s2.TargetPath       = $pywExe
$s2.Arguments        = "`"$daemonDst`""
$s2.WorkingDirectory = $ARAD_DIR
$s2.Description      = "ARAD Bulk WhatsApp Daemon"
$s2.Save()
Write-Host "  [OK] Start Menu shortcut" -ForegroundColor Green

# --- 7. Register auto-start at Windows login ---
Write-Host ""
Write-Host "[7/7] Setting up auto-start at Windows login..." -ForegroundColor Yellow
$taskName = "AradBulkDaemon"
try { schtasks /Delete /TN $taskName /F 2>$null | Out-Null } catch {}
$schArgs = "/Create /TN `"$taskName`" /TR `"`\`"$pywExe`\`" `\`"$daemonDst`\`"`" /SC ONLOGON /RL LIMITED /F"
$schResult = cmd /c "schtasks $schArgs" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] Auto-start task registered: $taskName" -ForegroundColor Green
} else {
    Write-Host "  [!] Could not register auto-start (non-fatal): $schResult" -ForegroundColor Yellow
    Write-Host "      You can start manually via desktop shortcut." -ForegroundColor Yellow
}

# --- DONE - start daemon now for immediate testing ---
Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host "  DONE.  Starting daemon now..."            -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
Start-Process -FilePath $pywExe -ArgumentList "`"$daemonDst`"" -WindowStyle Hidden
Start-Sleep -Seconds 4

# Verify daemon is up
try {
    $resp = Invoke-RestMethod "http://127.0.0.1:8766/status" -TimeoutSec 3
    Write-Host ""
    Write-Host "  [OK] Daemon is RUNNING on http://127.0.0.1:8766" -ForegroundColor Green
    Write-Host "       Response: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Open ARAD Bridge popup - 'WhatsApp Bulk' should show GREEN" -ForegroundColor White
    Write-Host "  2. Click 'Open Chrome Test for QR' to login WhatsApp Web" -ForegroundColor White
    Write-Host "  3. Scan QR with your phone" -ForegroundColor White
    Write-Host "  4. Done - daemon is ready for bulk sends" -ForegroundColor White
} catch {
    Write-Host ""
    Write-Host "  [!] Daemon not responding. Run manually to see error:" -ForegroundColor Yellow
    Write-Host "      & `"$pyExe`" `"$daemonDst`"" -ForegroundColor Yellow
}
Write-Host ""

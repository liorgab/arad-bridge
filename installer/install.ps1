# =====================================================================
# ARAD Bridge - Smart Installer
# =====================================================================
# Installs everything needed to run the ARAD Bridge ecosystem on Windows:
#   1. Python 3.12 (auto-install via winget → python.org fallback, USER-LEVEL)
#   2. Python packages (selenium, flask, flask-cors, requests, pyperclip)
#   3. Google Chrome (auto-install if missing)
#   4. Chrome for Testing (downloaded fresh, isolated for daemon use)
#   5. ChromeDriver (matching version)
#   6. Bulk Sender Daemon (Python + Flask + Selenium)
#   7. Desktop shortcut + optional auto-start at login
#   8. Native Messaging Helper (for PDF dialog automation)
#   9. Guides user through Extension load + Base44 components copy
#
# Designed to run WITHOUT admin elevation (user-level install everywhere).
# =====================================================================

param(
    [switch]$Quiet,
    [switch]$SkipPython,
    [switch]$SkipChrome,
    [switch]$SkipChromeForTesting,
    [switch]$SkipExtensionPrompt,
    [switch]$AutoStart,         # If set, skips the prompt and enables auto-start
    [switch]$NoAutoStart        # If set, skips the prompt and disables auto-start
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference    = 'SilentlyContinue'  # speeds up Invoke-WebRequest

# Force UTF-8 for proper Hebrew rendering
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

# ─── Constants ───────────────────────────────────────────────────────
# install.ps1 lives inside installer/ — repo root is one level up
$REPO_ROOT     = Split-Path -Parent $PSScriptRoot
# Backwards-compat fallback: if invoked directly from repo root (no installer/ folder), use $PSScriptRoot
if (-not (Test-Path (Join-Path $REPO_ROOT 'extension'))) {
    $REPO_ROOT = $PSScriptRoot
}
$INSTALL_BASE  = "$env:LOCALAPPDATA\AradBridge"        # repo + scripts
$DAEMON_BASE   = "$env:LOCALAPPDATA\AradBulkDaemon"    # daemon + chromedriver + profile
$CFT_BASE      = "$env:LOCALAPPDATA\AradChromeTest"    # Chrome for Testing
$NATIVE_BASE   = "$env:APPDATA\AradNativeHelper"       # Native Messaging Helper
$LOG_FILE      = "$env:TEMP\arad_install.log"

$PYTHON_VERSION_TARGET = '3.12.6'
$DAILY_CAP             = 150
$VERSION               = (Get-Content "$REPO_ROOT\VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $VERSION) { $VERSION = '1.0.0' }

# ─── Helpers ────────────────────────────────────────────────────────
function Write-Section($title) {
    Write-Host ''
    Write-Host ('═' * 64) -ForegroundColor DarkCyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ('═' * 64) -ForegroundColor DarkCyan
}

function Write-Step($idx, $total, $msg) {
    Write-Host ''
    Write-Host "[$idx/$total] $msg" -ForegroundColor Yellow
}

function Write-Ok($msg)    { Write-Host "      ✅ $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "      ⚠️  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "      ❌ $msg" -ForegroundColor Red }
function Write-Info($msg)  { Write-Host "      ℹ️  $msg" -ForegroundColor Gray }

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    # Re-read PATH from registry so newly installed binaries are findable in this session
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path    = "$machinePath;$userPath"
}

function Confirm-YesNo($question, $default = 'Y') {
    if ($Quiet) { return ($default -eq 'Y') }
    $opts = if ($default -eq 'Y') { '[Y/n]' } else { '[y/N]' }
    $ans = Read-Host "$question $opts"
    if ([string]::IsNullOrWhiteSpace($ans)) { $ans = $default }
    return ($ans -match '^[yY]')
}

# ─── Pre-flight ─────────────────────────────────────────────────────
function Show-Banner {
    Clear-Host
    Write-Host ''
    Write-Host '  ╔════════════════════════════════════════════════════════════╗' -ForegroundColor Cyan
    Write-Host '  ║                                                            ║' -ForegroundColor Cyan
    Write-Host '  ║          ARAD Bridge - Smart Installer                   ║' -ForegroundColor Cyan
    Write-Host "  ║                  Version $VERSION                            ║" -ForegroundColor Cyan
    Write-Host '  ║                                                            ║' -ForegroundColor Cyan
    Write-Host '  ║   PIBA · HopOn · WhatsApp · Bulk Sender Daemon (Modular)             ║' -ForegroundColor Cyan
    Write-Host '  ║                                                            ║' -ForegroundColor Cyan
    Write-Host '  ╚════════════════════════════════════════════════════════════╝' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Log file: ' -NoNewline -ForegroundColor Gray
    Write-Host $LOG_FILE -ForegroundColor White
    Write-Host '  Repo:     ' -NoNewline -ForegroundColor Gray
    Write-Host $REPO_ROOT -ForegroundColor White
    Write-Host ''
}

function Test-WindowsVersion {
    $osv = [System.Environment]::OSVersion.Version
    if ($osv.Major -lt 10) {
        Write-Err "Windows 10 or 11 required. Detected: $($osv.Major).$($osv.Minor)"
        exit 1
    }
    Write-Ok "Windows $($osv.Major) detected"
}

# ─── Step: Python ────────────────────────────────────────────────────
function Install-PythonViaWinget {
    if (-not (Test-Command 'winget')) {
        return $false
    }
    Write-Info 'Trying winget install Python.Python.3.12...'
    try {
        $proc = Start-Process -FilePath 'winget' `
            -ArgumentList @('install', '-e', '--id', 'Python.Python.3.12',
                            '--accept-package-agreements', '--accept-source-agreements',
                            '--scope', 'user', '--silent') `
            -Wait -PassThru -NoNewWindow
        if ($proc.ExitCode -eq 0) {
            Refresh-Path
            return $true
        }
    } catch {
        Log "winget install failed: $_"
    }
    return $false
}

function Install-PythonDirect {
    Write-Info "Downloading Python $PYTHON_VERSION_TARGET from python.org..."
    $url     = "https://www.python.org/ftp/python/$PYTHON_VERSION_TARGET/python-$PYTHON_VERSION_TARGET-amd64.exe"
    $exePath = "$env:TEMP\python-installer.exe"
    try {
        Invoke-WebRequest -Uri $url -OutFile $exePath -UseBasicParsing
    } catch {
        Write-Err "Download failed: $_"
        return $false
    }

    Write-Info 'Running silent user-level install (no admin needed)...'
    # User-level install, prepend to PATH, include pip, no documentation
    $args = @(
        '/quiet',
        'InstallAllUsers=0',
        'PrependPath=1',
        'Include_pip=1',
        'Include_test=0',
        'Include_doc=0',
        'Include_launcher=0',
        'SimpleInstall=1'
    )
    $proc = Start-Process -FilePath $exePath -ArgumentList $args -Wait -PassThru
    Remove-Item $exePath -ErrorAction SilentlyContinue

    if ($proc.ExitCode -ne 0) {
        Write-Err "Python installer exited with code $($proc.ExitCode)"
        return $false
    }
    Refresh-Path
    return $true
}

function Find-Python {
    foreach ($cmd in @('python', 'python3', 'py')) {
        try {
            $ver = & $cmd --version 2>&1
            if ($ver -match 'Python (\d+)\.(\d+)\.(\d+)') {
                $major = [int]$Matches[1]
                $minor = [int]$Matches[2]
                if ($major -ge 3 -and $minor -ge 8) {
                    $exe = (Get-Command $cmd).Source
                    return @{ Exe = $exe; Version = "$major.$minor.$($Matches[3])" }
                }
            }
        } catch { }
    }
    return $null
}

function Step-Python($idx, $total) {
    Write-Step $idx $total 'Checking Python 3.8+...'

    if ($SkipPython) {
        Write-Warn 'Skipping Python (flag -SkipPython)'
        return Find-Python
    }

    $py = Find-Python
    if ($py) {
        Write-Ok "Python $($py.Version) found at $($py.Exe)"
        return $py
    }

    Write-Warn 'Python not found. Attempting auto-install...'

    $installed = $false
    if (Install-PythonViaWinget) {
        Refresh-Path
        $py = Find-Python
        if ($py) {
            Write-Ok "Python $($py.Version) installed via winget"
            return $py
        }
        Write-Warn 'winget done but Python not in PATH - trying direct install'
    }

    if (Install-PythonDirect) {
        Refresh-Path
        $py = Find-Python
        if ($py) {
            Write-Ok "Python $($py.Version) installed from python.org"
            return $py
        }
    }

    Write-Err 'Auto-install failed'
    Write-Host ''
    Write-Host '   Download and install manually from:' -ForegroundColor Yellow
    Write-Host '   https://www.python.org/downloads/' -ForegroundColor Cyan
    Write-Host '   IMPORTANT: Check "Add Python to PATH" during install' -ForegroundColor Yellow
    Start-Process 'https://www.python.org/downloads/'
    exit 1
}

# ─── Step: Python packages ───────────────────────────────────────────
function Step-PythonPackages($idx, $total, $py) {
    Write-Step $idx $total 'Installing Python packages (selenium, flask, ...)...'

    $pkgs = @('selenium', 'flask', 'flask-cors', 'requests', 'pyperclip')
    $args = @('-m', 'pip', 'install', '--user', '--upgrade', '--disable-pip-version-check') + $pkgs

    $proc = Start-Process -FilePath $py.Exe -ArgumentList $args -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput "$env:TEMP\pip_stdout.txt" `
        -RedirectStandardError  "$env:TEMP\pip_stderr.txt"

    if ($proc.ExitCode -ne 0) {
        $errOut = Get-Content "$env:TEMP\pip_stderr.txt" -Raw -ErrorAction SilentlyContinue
        Write-Err "pip install failed"
        Write-Host $errOut -ForegroundColor DarkRed
        exit 1
    }
    Write-Ok 'Packages installed: selenium, flask, flask-cors, requests, pyperclip'
}

# ─── Step: Regular Chrome ────────────────────────────────────────────
function Find-Chrome {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-ChromeVersion($exePath) {
    try {
        return (Get-Item $exePath).VersionInfo.ProductVersion
    } catch { return $null }
}

function Install-ChromeViaWinget {
    if (-not (Test-Command 'winget')) { return $false }
    Write-Info 'Trying winget install Google.Chrome...'
    try {
        $proc = Start-Process -FilePath 'winget' `
            -ArgumentList @('install', '-e', '--id', 'Google.Chrome',
                            '--accept-package-agreements', '--accept-source-agreements',
                            '--silent') `
            -Wait -PassThru -NoNewWindow
        return ($proc.ExitCode -eq 0)
    } catch {
        Log "winget Chrome install failed: $_"
        return $false
    }
}

function Step-Chrome($idx, $total) {
    Write-Step $idx $total 'Checking Google Chrome...'
    if ($SkipChrome) { Write-Warn 'Skipping Chrome'; return $null }

    $chrome = Find-Chrome
    if ($chrome) {
        $ver = Get-ChromeVersion $chrome
        Write-Ok "Chrome $ver found at $chrome"
        return $chrome
    }

    Write-Warn 'Chrome not installed. Attempting auto-install...'
    if (Install-ChromeViaWinget) {
        Start-Sleep -Seconds 2
        $chrome = Find-Chrome
        if ($chrome) {
            Write-Ok "Chrome installed via winget"
            return $chrome
        }
    }

    Write-Warn 'Chrome auto-install failed'
    Write-Host '   Download and install manually: https://www.google.com/chrome/' -ForegroundColor Cyan
    Start-Process 'https://www.google.com/chrome/'
    if (Confirm-YesNo 'Chrome installed manually? Continue?' 'Y') {
        $chrome = Find-Chrome
        if ($chrome) { return $chrome }
    }
    Write-Warn 'Continuing without Chrome - install before loading Extension'
    return $null
}

# ─── Step: Chrome for Testing + ChromeDriver ─────────────────────────
function Get-LatestStableCfTVersion {
    try {
        $resp = Invoke-RestMethod -Uri 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json' -UseBasicParsing
        return $resp.channels.Stable
    } catch {
        Log "failed to fetch CfT versions: $_"
        return $null
    }
}

function Step-ChromeForTesting($idx, $total) {
    Write-Step $idx $total 'Installing Chrome for Testing + ChromeDriver...'
    if ($SkipChromeForTesting) { Write-Warn 'Skipping'; return $null }

    $existing = "$CFT_BASE\chrome-win64\chrome.exe"
    if (Test-Path $existing) {
        $ver = Get-ChromeVersion $existing
        Write-Ok "Chrome for Testing $ver already installed"
        # Still need to ensure chromedriver matches; continue to driver step
    } else {
        $stable = Get-LatestStableCfTVersion
        if (-not $stable) {
            Write-Err 'Could not connect to googlechromelabs - check internet'
            exit 1
        }
        $cftVer = $stable.version
        $cftUrl = ($stable.downloads.'chrome' | Where-Object { $_.platform -eq 'win64' }).url
        if (-not $cftUrl) {
            Write-Err 'CfT URL not found'
            exit 1
        }
        Write-Info "Downloading Chrome for Testing $cftVer (~150MB)..."

        New-Item -Path $CFT_BASE -ItemType Directory -Force | Out-Null
        $zipPath = "$env:TEMP\chrome-for-testing.zip"
        Invoke-WebRequest -Uri $cftUrl -OutFile $zipPath -UseBasicParsing
        Write-Info 'Extracting...'
        Expand-Archive -Path $zipPath -DestinationPath $CFT_BASE -Force
        Remove-Item $zipPath -ErrorAction SilentlyContinue
        Write-Ok "Chrome for Testing $cftVer extracted to $CFT_BASE\chrome-win64\"
    }

    # ChromeDriver
    New-Item -Path $DAEMON_BASE -ItemType Directory -Force | Out-Null
    $chromedriverPath = "$DAEMON_BASE\chromedriver.exe"

    $cftExe = "$CFT_BASE\chrome-win64\chrome.exe"
    $cftVer = Get-ChromeVersion $cftExe

    $needDriver = $true
    if (Test-Path $chromedriverPath) {
        try {
            $driverVer = & $chromedriverPath --version
            if ($driverVer -match '\b(\d+)\.') {
                $driverMajor = [int]$Matches[1]
                if ($cftVer -match '^(\d+)\.') {
                    $cftMajor = [int]$Matches[1]
                    if ($driverMajor -eq $cftMajor) { $needDriver = $false }
                }
            }
        } catch { }
    }

    if ($needDriver) {
        Write-Info "Downloading matching ChromeDriver for Chrome $cftVer..."
        $stable = Get-LatestStableCfTVersion
        $driverUrl = ($stable.downloads.'chromedriver' | Where-Object { $_.platform -eq 'win64' }).url
        if (-not $driverUrl) { Write-Err 'ChromeDriver URL not found'; exit 1 }
        $zipPath = "$env:TEMP\chromedriver.zip"
        Invoke-WebRequest -Uri $driverUrl -OutFile $zipPath -UseBasicParsing
        $extractDir = "$env:TEMP\chromedriver_extract"
        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $foundDriver = Get-ChildItem -Path $extractDir -Recurse -Filter 'chromedriver.exe' | Select-Object -First 1
        if (-not $foundDriver) { Write-Err 'chromedriver.exe not found in archive'; exit 1 }
        Copy-Item $foundDriver.FullName $chromedriverPath -Force
        Remove-Item $zipPath -ErrorAction SilentlyContinue
        Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "ChromeDriver installed"
    } else {
        Write-Ok 'Compatible ChromeDriver already exists'
    }

    return @{ ChromePath = $cftExe; ChromedriverPath = $chromedriverPath }
}

# ─── Step: Daemon ────────────────────────────────────────────────────
function Step-Daemon($idx, $total, $cft) {
    Write-Step $idx $total 'Installing Bulk Sender Daemon...'

    New-Item -Path $DAEMON_BASE -ItemType Directory -Force | Out-Null
    $profileDir = "$DAEMON_BASE\profile"
    New-Item -Path $profileDir -ItemType Directory -Force | Out-Null

    $daemonSrc  = "$REPO_ROOT\daemon\arad_bulk_daemon.py"
    $daemonDest = "$DAEMON_BASE\arad_bulk_daemon.py"

    if (-not (Test-Path $daemonSrc)) {
        Write-Err "daemon source missing: $daemonSrc"
        exit 1
    }

    Copy-Item $daemonSrc $daemonDest -Force
    Write-Ok "arad_bulk_daemon.py copied to $DAEMON_BASE"

    # config.json - paths must NOT contain Hebrew characters (PowerShell encoding bug)
    $config = @{
        chrome_path        = $cft.ChromePath
        chromedriver_path  = $cft.ChromedriverPath
        profile_dir        = $profileDir
    } | ConvertTo-Json
    $configPath = "$DAEMON_BASE\config.json"
    [System.IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
    Write-Ok "config.json saved"

    # start_daemon.bat
    $py = Find-Python
    $batContent = @"
@echo off
title ARAD Bulk Sender Daemon
echo Starting ARAD Bulk Sender Daemon...
echo.
echo Leave this window OPEN while using bulk sending.
echo To stop: close this window or press Ctrl+C.
echo.
"$($py.Exe)" "$daemonDest"
pause
"@
    $batPath = "$DAEMON_BASE\start_daemon.bat"
    [System.IO.File]::WriteAllText($batPath, $batContent, $utf8NoBom)
    Write-Ok "start_daemon.bat created"

    # Hidden start variant (for Task Scheduler auto-start - no cmd window)
    $hiddenVbs = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "$batPath", 0, False
"@
    $vbsPath = "$DAEMON_BASE\start_daemon_hidden.vbs"
    [System.IO.File]::WriteAllText($vbsPath, $hiddenVbs, $utf8NoBom)

    # Desktop shortcut
    $desktop = [System.Environment]::GetFolderPath('Desktop')
    $shortcutPath = "$desktop\ARAD Bulk Sender.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($shortcutPath)
    $sc.TargetPath  = $batPath
    $sc.WorkingDirectory = $DAEMON_BASE
    $sc.IconLocation = "$cft.ChromePath, 0"
    $sc.Description = 'ARAD Bulk WhatsApp Sender Daemon'
    $sc.Save()
    Write-Ok "Desktop shortcut created"

    return @{ BatPath = $batPath; VbsPath = $vbsPath; DaemonPath = $daemonDest }
}

# ─── Step: Auto-start (Task Scheduler) ──────────────────────────────
function Step-AutoStart($idx, $total, $daemon) {
    Write-Step $idx $total 'Setting up daemon auto-start at Windows login...'

    $taskName = 'AradBulkDaemonDaemon'

    # Determine choice
    $enable = $null
    if ($AutoStart)        { $enable = $true }
    elseif ($NoAutoStart)  { $enable = $false }
    else {
        Write-Host ''
        Write-Host '   Start daemon automatically at every Windows login?' -ForegroundColor White
        Write-Host '   Pro: Daemon always ready - no need to start manually' -ForegroundColor Gray
        Write-Host '   Con: ~50MB RAM used in background' -ForegroundColor Gray
        Write-Host ''
        $enable = Confirm-YesNo '   Enable auto-start?' 'Y'
    }

    # Idempotent: remove any existing startup shortcut
    $oldShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ARAD Daemon.lnk'
    if (Test-Path $oldShortcut) { Remove-Item $oldShortcut -Force -ErrorAction SilentlyContinue }

    if (-not $enable) {
        Write-Info 'Auto-start disabled - launch manually from desktop shortcut'
        return $false
    }

    # Use Startup folder shortcut instead of schtasks - simpler, no escaping issues, no admin needed
    try {
        $startupFolder = [Environment]::GetFolderPath('Startup')
        $shortcutPath = Join-Path $startupFolder 'ARAD Daemon.lnk'
        $WshShell = New-Object -ComObject WScript.Shell
        $lnk = $WshShell.CreateShortcut($shortcutPath)
        $lnk.TargetPath = $daemon.BatPath
        $lnk.WorkingDirectory = Split-Path $daemon.BatPath -Parent
        $lnk.WindowStyle = 7
        $lnk.Description = 'ARAD Bulk Daemon - auto-start at Windows login'
        $lnk.Save()
        Write-Ok "Auto-start enabled via Startup folder: $shortcutPath"
        return $true
    } catch {
        Write-Warn "Could not create startup shortcut: $_"
        Write-Info 'You can continue - but will need to start daemon manually from desktop shortcut'
        return $false
    }
}

# ─── Step: Native Messaging Helper ──────────────────────────────────
function Step-NativeHelper($idx, $total) {
    Write-Step $idx $total 'Installing Native Messaging Helper (PDF dialog)...'

    $helperSrc = "$REPO_ROOT\extension\native-helper"
    if (-not (Test-Path $helperSrc)) {
        Write-Warn 'native-helper folder not found - skipping'
        return
    }

    New-Item -Path $NATIVE_BASE -ItemType Directory -Force | Out-Null
    Copy-Item "$helperSrc\*" $NATIVE_BASE -Recurse -Force
    Write-Ok "Native Helper copied to $NATIVE_BASE"

    # Run the helper's installer if exists
    $helperInstall = "$NATIVE_BASE\install.ps1"
    if (Test-Path $helperInstall) {
        try {
            & $helperInstall
            Write-Ok 'Native Manifest registered in Chrome'
        } catch {
            Write-Warn "native helper install failed: $_"
        }
    }
}

# ─── Step: Save install metadata ────────────────────────────────────
function Step-SaveMetadata($idx, $total) {
    Write-Step $idx $total 'Saving install metadata...'

    New-Item -Path $INSTALL_BASE -ItemType Directory -Force | Out-Null
    $meta = @{
        version       = $VERSION
        installed_at  = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
        repo_root     = $REPO_ROOT
        install_base  = $INSTALL_BASE
        daemon_base   = $DAEMON_BASE
        cft_base      = $CFT_BASE
        native_base   = $NATIVE_BASE
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText("$INSTALL_BASE\install.json", $meta, $utf8NoBom)

    # Copy update.ps1, doctor.ps1, uninstall.ps1 for later use without needing the repo
    foreach ($script in @('update.ps1', 'doctor.ps1', 'uninstall.ps1')) {
        $src = "$REPO_ROOT\$script"
        if (Test-Path $src) {
            Copy-Item $src "$INSTALL_BASE\$script" -Force
        }
    }
    Write-Ok "metadata saved at $INSTALL_BASE"
}

# ─── Step: Final manual instructions ────────────────────────────────
function Step-ManualInstructions($idx, $total) {
    Write-Step $idx $total 'Final instructions (manual actions required)'

    $extPath  = "$REPO_ROOT\extension"
    $compPath = "$REPO_ROOT\base44-components"

    Write-Host ''
    Write-Host '   ┌─────────────────────────────────────────────────────────────┐' -ForegroundColor Yellow
    Write-Host '   │  Manual Step 1 - Load Chrome Extension                        │' -ForegroundColor Yellow
    Write-Host '   ├─────────────────────────────────────────────────────────────┤' -ForegroundColor Yellow
    Write-Host '   │  1. chrome://extensions/ tab opened for you                    │' -ForegroundColor White
    Write-Host '   │  2. Enable "Developer mode" (top-right corner)               │' -ForegroundColor White
    Write-Host '   │  3. Click "Load unpacked"                                      │' -ForegroundColor White
    Write-Host '   │  4. Select the folder:                                          │' -ForegroundColor White
    Write-Host "   │     $extPath" -ForegroundColor Cyan
    Write-Host '   └─────────────────────────────────────────────────────────────┘' -ForegroundColor Yellow

    if (-not $SkipExtensionPrompt) {
        # Open chrome://extensions/ — must launch via chrome.exe directly,
        # because Windows doesn't register chrome:// as a system URL protocol
        # (Start-Process chrome://... pops a Microsoft Store dialog).
        $chromeExe = Find-Chrome
        if ($chromeExe -and (Test-Path $chromeExe)) {
            Start-Process -FilePath $chromeExe -ArgumentList 'chrome://extensions/' -ErrorAction SilentlyContinue
        } else {
            Write-Info 'Chrome not found - open chrome://extensions/ manually'
        }
    }

    Write-Host ''
    Write-Host '   ┌─────────────────────────────────────────────────────────────┐' -ForegroundColor Yellow
    Write-Host '   │  Manual Step 2 - Connect WhatsApp Web in Chrome Test              │' -ForegroundColor Yellow
    Write-Host '   ├─────────────────────────────────────────────────────────────┤' -ForegroundColor Yellow
    Write-Host '   │  1. Open ARAD app (arad-admin.vercel.app)                                │' -ForegroundColor White
    Write-Host '   │  2. Click the Extension icon at top                          │' -ForegroundColor White
    Write-Host '   │  3. In "Bulk Sender" card - click "Open Chrome Test for QR"     │' -ForegroundColor White
    Write-Host '   │  4. Scan QR with phone - session saved forever                        │' -ForegroundColor White
    Write-Host '   └─────────────────────────────────────────────────────────────┘' -ForegroundColor Yellow

    Write-Host ''
    Write-Host '   ┌─────────────────────────────────────────────────────────────┐' -ForegroundColor Yellow
    Write-Host '   ┌─────────────────────────────────────────────────────────────┐' -ForegroundColor Yellow
    Write-Host '   │  Manual Step 3 - Modules auto-configure                       │' -ForegroundColor Yellow
    Write-Host '   ├─────────────────────────────────────────────────────────────┤' -ForegroundColor Yellow
    Write-Host '   │  No manual copying needed - ARAD app uses a handshake API     │' -ForegroundColor White
    Write-Host '   │  to enable modules at runtime (PIBA, HopOn, WA, Bulk).        │' -ForegroundColor White
    Write-Host '   │  Just refresh ARAD after loading the extension.               │' -ForegroundColor White
    Write-Host '   └─────────────────────────────────────────────────────────────┘' -ForegroundColor Yellow
}

# ─── Step: Health check ─────────────────────────────────────────────
function Step-HealthCheck($idx, $total) {
    Write-Step $idx $total 'Running health check...'
    $doctorPath = "$REPO_ROOT\doctor.ps1"
    if (Test-Path $doctorPath) {
        Write-Info 'Running doctor.ps1...'
        & $doctorPath -BriefMode
    } else {
        Write-Warn 'doctor.ps1 not found - Skipping'
    }
}

# ─── Final banner ───────────────────────────────────────────────────
function Show-FinalBanner($daemon) {
    Write-Host ''
    Write-Host '  ╔════════════════════════════════════════════════════════════╗' -ForegroundColor Green
    Write-Host '  ║                                                            ║' -ForegroundColor Green
    Write-Host '  ║          ✅ Installation complete!                          ║' -ForegroundColor Green
    Write-Host '  ║                                                            ║' -ForegroundColor Green
    Write-Host '  ╚════════════════════════════════════════════════════════════╝' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Future commands:' -ForegroundColor White
    Write-Host "    Update:           $INSTALL_BASE\update.ps1" -ForegroundColor Gray
    Write-Host "    Doctor:           $INSTALL_BASE\doctor.ps1" -ForegroundColor Gray
    Write-Host "    Uninstall:         $INSTALL_BASE\uninstall.ps1" -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Full install log:' -ForegroundColor White
    Write-Host "    $LOG_FILE" -ForegroundColor Gray
    Write-Host ''
}

# ═════════════════════════════════════════════════════════════════════
# Main
# ═════════════════════════════════════════════════════════════════════
try {
    Show-Banner
    Log "=== Install started: v$VERSION ==="
    Test-WindowsVersion

    $TOTAL = 9
    $py        = Step-Python              1 $TOTAL
    Step-PythonPackages                   2 $TOTAL $py
    $chrome    = Step-Chrome              3 $TOTAL
    $cft       = Step-ChromeForTesting    4 $TOTAL
    $daemon    = Step-Daemon              5 $TOTAL $cft
    $autoStart = Step-AutoStart           6 $TOTAL $daemon
    Step-NativeHelper                     7 $TOTAL
    Step-SaveMetadata                     8 $TOTAL
    Step-ManualInstructions               9 $TOTAL

    # If auto-start was enabled, kick off the daemon now (without waiting for reboot)
    if ($autoStart) {
        Write-Host ''
        Write-Info 'Starting daemon now...'
        Start-Process 'wscript.exe' -ArgumentList "`"$($daemon.VbsPath)`""
        Start-Sleep -Seconds 3
    }

    Show-FinalBanner $daemon
    Log "=== Install completed ==="
} catch {
    Write-Host ''
    Write-Err "Install error: $_"
    Log "FATAL: $_"
    Log $_.ScriptStackTrace
    Write-Host '   Full log:' -ForegroundColor Yellow
    Write-Host "   $LOG_FILE" -ForegroundColor Cyan
    exit 1
}

# =====================================================================
# ARAD Bridge - Uninstaller
# =====================================================================
# Removes all ARAD Bridge components from this user's Windows account:
#   1. Stops a running daemon (graceful POST /shutdown → fall back to kill)
#   2. %LOCALAPPDATA%\AradBridge       (install metadata + scripts)
#   3. %LOCALAPPDATA%\AradBulkDaemon   (daemon, chromedriver, WA profile)
#   4. %LOCALAPPDATA%\AradChromeTest   (Chrome for Testing - ~250MB)
#   5. %APPDATA%\AradNativeHelper      (Native Messaging helper)
#   6. Desktop / Start Menu / Startup shortcuts
#   7. Scheduled task "AradBulkDaemon" (if it exists)
#   8. Native Messaging registration (registry key)
#
# What we DO NOT touch (intentionally):
#   - Python              (you may use it for other projects)
#   - Google Chrome       (your daily browser)
#   - D.Yohai Bridge      (separate extension, separate folders)
#   - The Chrome Extension itself - you must remove it manually from
#     chrome://extensions (we can't reach it from PowerShell)
#
# Switches:
#   -KeepWaLogin  Keep the WhatsApp Web login profile so a future
#                 re-install doesn't require scanning QR again.
#                 Only AradBulkDaemon\profile\ is preserved.
#   -Quiet        Don't prompt, assume yes.
# =====================================================================

param(
    [switch]$KeepWaLogin,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

# ─── Paths ─────────────────────────────────────────────────────────
$INSTALL_BASE  = "$env:LOCALAPPDATA\AradBridge"
$DAEMON_BASE   = "$env:LOCALAPPDATA\AradBulkDaemon"
$CFT_BASE      = "$env:LOCALAPPDATA\AradChromeTest"
$NATIVE_BASE   = "$env:APPDATA\AradNativeHelper"
$LOG_FILE      = "$env:TEMP\arad_uninstall.log"

$DESKTOP_SHORTCUT  = Join-Path ([Environment]::GetFolderPath('Desktop'))  'ARAD Bulk Daemon.lnk'
$STARTMENU_SHORTCUT= Join-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" 'ARAD Bulk Daemon.lnk'
$STARTUP_SHORTCUT  = Join-Path ([Environment]::GetFolderPath('Startup'))  'ARAD Daemon.lnk'
$STARTUP_SHORTCUT2 = Join-Path ([Environment]::GetFolderPath('Startup'))  'ARAD Bulk Daemon.lnk'

$TASK_NAME      = 'AradBulkDaemon'
$ALT_TASK_NAME  = 'AradBulkSenderDaemon'

$NATIVE_HOST_KEY = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.arad.bridge'

# ─── Helpers ───────────────────────────────────────────────────────
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
function Write-Ok($msg)    { Write-Host "      [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "      [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "      [X]  $msg" -ForegroundColor Red }
function Write-Info($msg)  { Write-Host "      $msg" -ForegroundColor Gray }

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Confirm-YesNo($q, $default = 'Y') {
    if ($Quiet) { return ($default -eq 'Y') }
    $opts = if ($default -eq 'Y') { '[Y/n]' } else { '[y/N]' }
    $ans = Read-Host "$q $opts"
    if ([string]::IsNullOrWhiteSpace($ans)) { $ans = $default }
    return ($ans -match '^[yY]')
}

function Remove-FolderSafe($path, $label, $keepSubpath = $null) {
    if (-not (Test-Path $path)) {
        Write-Info "skipped (not installed): $label"
        return
    }
    if ($keepSubpath) {
        $keepFull = Join-Path $path $keepSubpath
        if (Test-Path $keepFull) {
            $tmp = Join-Path $env:TEMP ("_arad_keep_" + [guid]::NewGuid().ToString('N'))
            try {
                Move-Item $keepFull $tmp -Force -ErrorAction Stop
                Write-Info "preserved: $keepSubpath  →  (temp)"
                Remove-Item $path -Recurse -Force -ErrorAction Stop
                New-Item -ItemType Directory -Path $path -Force | Out-Null
                Move-Item $tmp (Join-Path $path $keepSubpath) -Force
                Write-Ok "removed (kept $keepSubpath): $label"
                return
            } catch {
                Write-Warn "preserve failed, deleting whole folder: $_"
                if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
    }
    try {
        Remove-Item $path -Recurse -Force -ErrorAction Stop
        Write-Ok "removed: $label"
    } catch {
        Write-Err "could not remove $label : $_"
        Log "remove $path failed: $_"
    }
}

function Remove-FileSafe($path, $label) {
    if (-not (Test-Path $path)) {
        Write-Info "skipped (no $label)"
        return
    }
    try {
        Remove-Item $path -Force -ErrorAction Stop
        Write-Ok "removed: $label"
    } catch {
        Write-Err "could not remove $label : $_"
    }
}

# ─── Banner + confirmation ─────────────────────────────────────────
Clear-Host
Write-Host ''
Write-Host '  ╔════════════════════════════════════════════════════════════╗' -ForegroundColor Red
Write-Host '  ║                                                            ║' -ForegroundColor Red
Write-Host '  ║         ARAD Bridge - Uninstaller                          ║' -ForegroundColor Red
Write-Host '  ║                                                            ║' -ForegroundColor Red
Write-Host '  ╚════════════════════════════════════════════════════════════╝' -ForegroundColor Red
Write-Host ''
Write-Host '  This will remove:' -ForegroundColor White
Write-Host '    - Bulk Sender Daemon (running process, files, shortcuts)' -ForegroundColor Gray
Write-Host '    - Chrome for Testing (separate isolated Chrome, ~250MB)' -ForegroundColor Gray
Write-Host '    - Install metadata + Native Messaging helper' -ForegroundColor Gray
Write-Host '    - Scheduled task / autostart shortcut' -ForegroundColor Gray
Write-Host ''
Write-Host '  It will NOT remove:' -ForegroundColor White
Write-Host '    - Python / Google Chrome (you might use them elsewhere)' -ForegroundColor Gray
Write-Host '    - D.Yohai Bridge / its daemon (separate product)' -ForegroundColor Gray
Write-Host '    - The Chrome extension itself - remove via chrome://extensions' -ForegroundColor Gray
Write-Host ''
if ($KeepWaLogin) {
    Write-Host '  -KeepWaLogin set: the WhatsApp Web session will be preserved.' -ForegroundColor Cyan
    Write-Host ''
}
Write-Host "  Log: $LOG_FILE" -ForegroundColor DarkGray
Write-Host ''

if (-not (Confirm-YesNo '  Continue?')) {
    Write-Host ''
    Write-Host '  Aborted by user.' -ForegroundColor Yellow
    exit 0
}

Log '═══ uninstall started ═══'

# ─── Step 1: Stop running daemon ───────────────────────────────────
Write-Step 1 8 'Stopping ARAD Bulk Daemon (if running)...'
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/shutdown' -Method POST -TimeoutSec 3 -ErrorAction Stop
    Write-Ok 'graceful shutdown OK'
    Start-Sleep -Seconds 2
} catch {
    Write-Info 'no daemon responded (probably not running)'
}

# Fallback: kill any python process running arad_bulk_daemon
try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction Stop |
             Where-Object { $_.CommandLine -like '*arad_bulk_daemon*' }
    if ($procs) {
        foreach ($p in $procs) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Ok "killed PID $($p.ProcessId)"
        }
    } else {
        Write-Info 'no leftover python processes'
    }
} catch {
    Write-Warn "kill scan failed: $_"
}

# ─── Step 2: Scheduled task ────────────────────────────────────────
Write-Step 2 8 'Removing scheduled task (if exists)...'
foreach ($name in @($TASK_NAME, $ALT_TASK_NAME)) {
    $exists = $false
    try {
        schtasks /Query /TN $name 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $exists = $true }
    } catch {}
    if ($exists) {
        try {
            schtasks /Delete /TN $name /F 2>$null | Out-Null
            Write-Ok "removed task: $name"
        } catch {
            Write-Warn "could not delete task ${name}: $_"
        }
    } else {
        Write-Info "no task: $name"
    }
}

# ─── Step 3: Shortcuts ─────────────────────────────────────────────
Write-Step 3 8 'Removing shortcuts...'
Remove-FileSafe $DESKTOP_SHORTCUT    'Desktop shortcut'
Remove-FileSafe $STARTMENU_SHORTCUT  'Start Menu shortcut'
Remove-FileSafe $STARTUP_SHORTCUT    'Startup shortcut (ARAD Daemon.lnk)'
Remove-FileSafe $STARTUP_SHORTCUT2   'Startup shortcut (ARAD Bulk Daemon.lnk)'

# ─── Step 4: Native Messaging registration ─────────────────────────
Write-Step 4 8 'Removing Native Messaging registration...'
if (Test-Path $NATIVE_HOST_KEY) {
    try {
        Remove-Item $NATIVE_HOST_KEY -Recurse -Force -ErrorAction Stop
        Write-Ok 'removed registry key for com.arad.bridge'
    } catch {
        Write-Warn "could not remove registry key: $_"
    }
} else {
    Write-Info 'no Native Messaging registration found'
}

# ─── Step 5: AradBulkDaemon (with optional preserve) ───────────────
Write-Step 5 8 'Removing AradBulkDaemon folder...'
if ($KeepWaLogin) {
    Remove-FolderSafe $DAEMON_BASE 'AradBulkDaemon' 'profile'
} else {
    Remove-FolderSafe $DAEMON_BASE 'AradBulkDaemon'
}

# ─── Step 6: AradChromeTest ────────────────────────────────────────
Write-Step 6 8 'Removing AradChromeTest folder (~250MB)...'
Remove-FolderSafe $CFT_BASE 'AradChromeTest'

# ─── Step 7: AradNativeHelper ──────────────────────────────────────
Write-Step 7 8 'Removing AradNativeHelper folder...'
Remove-FolderSafe $NATIVE_BASE 'AradNativeHelper'

# ─── Step 8: AradBridge metadata (LAST so we can copy uninstall.ps1
#            out of it before deletion, in case user ran it from there) ─
Write-Step 8 8 'Removing AradBridge metadata folder...'
$selfPath = $MyInvocation.MyCommand.Path
if ($selfPath -and (Test-Path $selfPath) -and $selfPath.StartsWith($INSTALL_BASE, 'OrdinalIgnoreCase')) {
    Write-Info 'uninstall script is running from inside AradBridge - copying to %TEMP% before delete'
    $tempCopy = Join-Path $env:TEMP 'arad_uninstall_tail.ps1'
    Copy-Item $selfPath $tempCopy -Force -ErrorAction SilentlyContinue
}
Remove-FolderSafe $INSTALL_BASE 'AradBridge'

# ─── Final banner ──────────────────────────────────────────────────
Write-Host ''
Write-Host '  ╔════════════════════════════════════════════════════════════╗' -ForegroundColor Green
Write-Host '  ║                                                            ║' -ForegroundColor Green
Write-Host '  ║          Uninstall complete!                               ║' -ForegroundColor Green
Write-Host '  ║                                                            ║' -ForegroundColor Green
Write-Host '  ╚════════════════════════════════════════════════════════════╝' -ForegroundColor Green
Write-Host ''
Write-Host '  ONE MANUAL STEP LEFT:' -ForegroundColor Yellow
Write-Host '    Open chrome://extensions and click "Remove" on ARAD Bridge.' -ForegroundColor White
Write-Host '    (PowerShell cannot uninstall Chrome extensions for security reasons.)' -ForegroundColor Gray
Write-Host ''
if ($KeepWaLogin -and (Test-Path (Join-Path $DAEMON_BASE 'profile'))) {
    Write-Host '  WhatsApp Web session preserved at:' -ForegroundColor Cyan
    Write-Host "    $DAEMON_BASE\profile\" -ForegroundColor White
    Write-Host '  Next install will reuse it - no QR scan needed.' -ForegroundColor Gray
    Write-Host ''
}
Write-Host "  Log saved to: $LOG_FILE" -ForegroundColor DarkGray
Write-Host ''

Log '═══ uninstall complete ═══'

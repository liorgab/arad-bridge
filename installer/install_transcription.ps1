# ====================================================================
#  ARAD Bridge - Meeting transcription prerequisites
# ====================================================================
#  Run AFTER install_daemon.ps1:
#      powershell -ExecutionPolicy Bypass -File installer\install_transcription.ps1
#
#  The daemon runs fine without any of this - `transcribe_available()` and
#  `diarize_available()` simply report what is missing and the module stays
#  unavailable. This script installs the optional half:
#
#    1. the Python packages (faster-whisper + the av<19 pin + sherpa-onnx)
#    2. the two ONNX speaker models, ~34MB, which are NOT in git
#
#  *** WHAT THIS DOES **NOT** DO, AND MUST NEVER DO
#  Diarization here separates the speakers *inside one meeting* and keeps
#  nothing: no voice print is stored, no speaker database is built, and the
#  audio is deleted when the transcript is approved. The models below are a
#  tool used for one recording and discarded - do not add anything that
#  persists an embedding between meetings.
# ====================================================================

param([switch]$SkipPackages, [switch]$SkipModels)

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  ARAD - Meeting transcription setup"       -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

$ARAD_DIR   = Join-Path $env:LOCALAPPDATA "AradBulkDaemon"
$MODELS_DIR = Join-Path $ARAD_DIR "models"
$REPO_ROOT  = Split-Path -Parent $PSScriptRoot
$REQS       = Join-Path $REPO_ROOT "daemon\requirements.txt"

if (-not (Test-Path $ARAD_DIR)) {
    Write-Host "  [X] $ARAD_DIR not found - run installer\install_daemon.ps1 first." -ForegroundColor Red
    exit 1
}

# --- 1. Python packages -------------------------------------------------
Write-Host "[1/3] Python packages..." -ForegroundColor Yellow
# the SAME finder install_daemon.ps1 uses: packages must land in the
# interpreter the daemon actually runs under, or it reports them missing forever
. "$PSScriptRoot\_find_python.ps1"
$pyExe = Find-AradPython
if (-not $pyExe) { Write-Host "  [X] Python not found." -ForegroundColor Red; exit 1 }

if ($SkipPackages) {
    Write-Host "  [-] skipped (-SkipPackages)" -ForegroundColor Gray
} elseif (-not (Test-Path $REQS)) {
    Write-Host "  [X] requirements.txt not found at $REQS" -ForegroundColor Red
    exit 1
} else {
    # requirements.txt carries the pins, including av==18.1.0. Installing the
    # file rather than a hand-typed list is the whole point: faster-whisper
    # asks for av>=11 with no upper bound, PyAV 19 removed the argument it
    # passes, and a loose install breaks EVERY decode with a TypeError.
    Write-Host "  Installing from daemon\requirements.txt (this is ~250MB, it takes a while)..." -ForegroundColor Gray
    & $pyExe -m pip install --upgrade --requirement $REQS
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [X] pip failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit 1
    }
    Write-Host "  [OK] packages installed" -ForegroundColor Green
}

# --- 2. ONNX speaker models --------------------------------------------
Write-Host ""
Write-Host "[2/3] Speaker models (~34MB)..." -ForegroundColor Yellow

# Pinned upstream assets from k2-fsa/sherpa-onnx. The segmentation model is
# pyannote 3.0 (MIT) exported to ONNX.
# !! The embedding model's release tag is spelled "speaker-recongition-models"
#    UPSTREAM - that typo is part of the real URL. The correctly spelled tag
#    404s. Verified 02/11/26; do not "fix" it.
$SEG_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
$EMB_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx"

$segDir  = Join-Path $MODELS_DIR "sherpa-onnx-pyannote-segmentation-3-0"
$segFile = Join-Path $segDir "model.onnx"
$embFile = Join-Path $MODELS_DIR "wespeaker_en_voxceleb_resnet34.onnx"

if ($SkipModels) {
    Write-Host "  [-] skipped (-SkipModels)" -ForegroundColor Gray
} else {
    New-Item -ItemType Directory -Path $MODELS_DIR -Force | Out-Null

    # A model file that exists but is a few KB is a failed download, not an
    # install - treat anything implausibly small as absent and fetch again.
    function Need-File([string]$path, [int]$minBytes) {
        if (-not (Test-Path $path)) { return $true }
        return ((Get-Item $path).Length -lt $minBytes)
    }

    if (Need-File $embFile 20000000) {
        Write-Host "  Downloading speaker embedding model (~26MB)..." -ForegroundColor Gray
        try {
            Invoke-WebRequest -Uri $EMB_URL -OutFile $embFile -UseBasicParsing
            Write-Host "  [OK] wespeaker_en_voxceleb_resnet34.onnx" -ForegroundColor Green
        } catch {
            Write-Host ("  [X] download failed: " + $_.Exception.Message) -ForegroundColor Red
        }
    } else {
        Write-Host "  [OK] embedding model already present" -ForegroundColor Green
    }

    if (Need-File $segFile 2000000) {
        Write-Host "  Downloading segmentation model (~6MB)..." -ForegroundColor Gray
        $tar = Join-Path $env:TEMP "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
        try {
            Invoke-WebRequest -Uri $SEG_URL -OutFile $tar -UseBasicParsing
            # bsdtar ships with Windows 10 1803+ and reads tar.bz2 natively;
            # Expand-Archive cannot.
            & tar -xf $tar -C $MODELS_DIR
            Remove-Item $tar -Force -ErrorAction SilentlyContinue
            if (Test-Path $segFile) {
                Write-Host "  [OK] sherpa-onnx-pyannote-segmentation-3-0\model.onnx" -ForegroundColor Green
            } else {
                Write-Host "  [X] archive extracted but model.onnx is not where the daemon looks:" -ForegroundColor Red
                Write-Host ("      " + $segFile) -ForegroundColor Red
            }
        } catch {
            Write-Host ("  [X] download failed: " + $_.Exception.Message) -ForegroundColor Red
        }
    } else {
        Write-Host "  [OK] segmentation model already present" -ForegroundColor Green
    }
}

# --- 3. Ask the daemon itself -------------------------------------------
Write-Host ""
Write-Host "[3/3] Verifying against the running daemon..." -ForegroundColor Yellow
# The daemon's own /status is the exit condition: it reports `transcribe` and
# `diarize` with a `detail` naming exactly what is missing. Anything else here
# would be this script marking its own homework.
try {
    $st = Invoke-RestMethod "http://127.0.0.1:8766/status" -TimeoutSec 5
    $tr = $st.transcribe
    $di = $st.diarize
    if ($tr.available) { Write-Host "  [OK] transcribe: $($tr.detail) (model: $($tr.model))" -ForegroundColor Green }
    else               { Write-Host "  [X] transcribe: $($tr.detail)" -ForegroundColor Red }
    if ($di.available) { Write-Host "  [OK] diarize:    $($di.detail)" -ForegroundColor Green }
    else               { Write-Host "  [X] diarize:    $($di.detail)" -ForegroundColor Red }

    if (-not ($tr.available -and $di.available)) {
        Write-Host ""
        Write-Host "  [!] The daemon was started BEFORE this install - restart it" -ForegroundColor Yellow
        Write-Host "      (desktop shortcut 'ARAD Bulk Daemon') and run this script again." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [!] Daemon is not answering on http://127.0.0.1:8766" -ForegroundColor Yellow
    Write-Host "      Start it from the desktop shortcut, then re-run this script to verify." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host "  DONE."                                    -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""

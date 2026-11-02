# ====================================================================
#  Shared: find the Python the daemon will actually run under
# ====================================================================
#  Dot-source this from any installer script:  . "$PSScriptRoot\_find_python.ps1"
#  Then call:  $py = Find-AradPython
#
#  WHY THIS IS SHARED AND NOT COPIED
#  Two scripts that each pick a Python their own way will sooner or later pick
#  DIFFERENT ones: the packages land in interpreter A while the daemon runs
#  under interpreter B, and the daemon reports "missing python module" forever
#  while pip insists everything is installed. One finder, one answer.
#
#  WHY NEWEST-FIRST
#  The old list was hard-coded 3.13 / 3.12 / 3.11 and stopped there, while the
#  daemon on the dev machine runs 3.14 - so the installer would have installed
#  the packages into 3.13 and the running daemon would never have seen them.
#  Measured 02/11/26: this machine has Python313 and Python314 side by side.
#  Every wheel the daemon needs exists for 3.14 (ctranslate2 cp314,
#  onnxruntime cp314, tokenizers abi3, faster-whisper py3) - measured for
#  ROADMAP 0.2 - so taking the newest is safe as well as correct.
# ====================================================================

function Find-AradPython {
    param([switch]$Quiet)

    $found = @()

    # 1. every PythonNNN under the per-user install root, newest first
    $roots = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python"),
        "C:\",
        (Join-Path $env:ProgramFiles "")
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem $root -Directory -Filter "Python3*" -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = Join-Path $_.FullName "python.exe"
            if (Test-Path $exe) {
                # "Python314" -> 314, so 3.9 never sorts above 3.14 the way a
                # string compare would
                $n = 0
                if ($_.Name -match 'Python(\d+)') { $n = [int]$Matches[1] }
                $found += [pscustomobject]@{ Exe = $exe; Rank = $n }
            }
        }
    }

    # 2. whatever is on PATH, as a last resort
    try {
        $onPath = (Get-Command python -ErrorAction Stop).Source
        if ($onPath -and -not ($found.Exe -contains $onPath)) {
            $found += [pscustomobject]@{ Exe = $onPath; Rank = 0 }
        }
    } catch {}

    if ($found.Count -eq 0) { return $null }

    $best = ($found | Sort-Object -Property Rank -Descending | Select-Object -First 1).Exe
    if (-not $Quiet) {
        $ver = (& $best -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>&1)
        Write-Host ("  [OK] Python: " + $best + "  (" + $ver + ")") -ForegroundColor Green
        if ($found.Count -gt 1) {
            Write-Host ("       " + $found.Count + " interpreters found - using the newest, and every") -ForegroundColor Gray
            Write-Host "       installer here uses this same one so packages and daemon agree." -ForegroundColor Gray
        }
    }
    return $best
}

# ═══════════════════════════════════════════════════════════════════
#  install_mpp2xml.ps1 — copy the built mpp2xml converter next to the daemon
# ═══════════════════════════════════════════════════════════════════
#  Run AFTER `dotnet publish -c Release` (see README.md). Copies the
#  self-contained publish output into %LOCALAPPDATA%\AradBulkDaemon\ so the
#  ARAD Bulk Daemon worker (cmd_convert_mpp) can shell out to mpp2xml.exe.
# ═══════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$publish = Join-Path $here 'bin\Release\net8.0\win-x64\publish'
$target  = Join-Path $env:LOCALAPPDATA 'AradBulkDaemon'

if (-not (Test-Path (Join-Path $publish 'mpp2xml.exe'))) {
  Write-Host "❌ Build output not found at:`n   $publish" -ForegroundColor Red
  Write-Host "   Run first:  dotnet publish -c Release" -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $target)) {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Write-Host "Created $target (daemon not installed yet — that's fine)."
}

Write-Host "Copying mpp2xml → $target ..."
Copy-Item -Path (Join-Path $publish '*') -Destination $target -Recurse -Force

$exe = Join-Path $target 'mpp2xml.exe'
if (Test-Path $exe) {
  Write-Host "✅ Installed: $exe" -ForegroundColor Green
  Write-Host "   No daemon restart needed. Test:  & '$exe' plan.mpp out.xml"
} else {
  Write-Host "❌ Copy failed." -ForegroundColor Red
  exit 1
}

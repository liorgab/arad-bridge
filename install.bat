@echo off
title ARAD Bridge Installer
echo Starting ARAD Bridge installer...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
echo.
echo Press any key to close...
pause >nul

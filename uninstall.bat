@echo off
title ARAD Bridge Uninstaller
echo Starting ARAD Bridge uninstaller...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\uninstall.ps1" %*
echo.
echo Press any key to close...
pause >nul

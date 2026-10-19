@echo off
setlocal
echo ==========================================================
echo  Inspecting FireClient Installer Security and UAC
echo ==========================================================
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Inspect-Release-Security.ps1"
echo.
pause

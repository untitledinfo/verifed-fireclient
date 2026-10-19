@echo off
setlocal
echo ==========================================================
echo  Install FireClient Publisher Trust in Windows
echo ==========================================================
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-Local-Publisher-Trust.ps1"
echo.
pause

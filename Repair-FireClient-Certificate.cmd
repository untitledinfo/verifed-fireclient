@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Repair-Certificate-Secret.ps1"
if errorlevel 1 (
  echo.
  echo The certificate could not be repaired automatically.
  echo Read the message above before continuing.
)
echo.
pause

@echo off
rem Double-click wrapper for install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. See the message above.
)
pause

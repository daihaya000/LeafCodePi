@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
setlocal
cd /d "%~dp0.."
echo [LeafCodePi] Creating a Desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
if errorlevel 1 (
  echo [LeafCodePi] Shortcut creation failed.
  pause
  exit /b 1
)
set "CP_ORIGINAL="
for /f "tokens=2 delims=:" %%C in ('chcp 2^>nul') do for /f "tokens=1" %%D in ("%%C") do set "CP_ORIGINAL=%%D"
chcp 65001 >nul 2>&1
type "%~dp0shortcut-messages\success.txt"
if defined CP_ORIGINAL chcp %CP_ORIGINAL% >nul 2>&1
pause
endlocal

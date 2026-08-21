@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem cmd.exe misparses batch files that contain multi-byte characters.
setlocal
cd /d "%~dp0.."

rem /quiet is passed by scripts\start-webui.bat for an unattended rebuild:
rem it must not block on `pause` since nothing is watching the console then.
set QUIET=
if /i "%~1"=="/quiet" set QUIET=1

set LAUNCHER_DIR=%CD%\scripts\launcher
set OUT_EXE=%CD%\LeafCodePi.exe
set OLD_EXE=%CD%\LeafCodePi.exe.old
set CSC=

rem Prefer the .NET Framework compiler that ships with Windows (no extra
rem install needed). Avoid `where` here: piping into this script (as the
rem automated test does) can make a nested `for /f ('where ...')` fight the
rem outer redirection, so a direct path/PATH probe is used instead.
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not defined CSC if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe

if not defined CSC (
  echo [LeafCodePi] C# compiler ^(csc.exe^) not found.
  echo [LeafCodePi] Install .NET Framework 4.x ^(Windows Features^) or the .NET SDK, then retry.
  if not defined QUIET pause
  exit /b 1
)

echo [LeafCodePi] Using compiler: %CSC%

echo [LeafCodePi] Extracting app icon from host\src\icon.json...
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('host/src/icon.json','utf8'));fs.writeFileSync('scripts/launcher/app.ico', Buffer.from(j.base64,'base64'));"
if errorlevel 1 (
  echo [LeafCodePi] Icon extraction failed. Run 'node scripts\gen-icons.mjs' first.
  if not defined QUIET pause
  exit /b 1
)

rem The exe at the repo root may be the very process running this script
rem (scripts\start-webui.bat rebuilds it on launch when its inputs are newer).
rem Windows locks a running exe against overwrite but allows a rename, so
rem swap it aside first, compile the new image, then drop the old one (a
rem running image can be deleted; the process keeps its mapped copy). On
rem failure the old exe is restored so the entry point is never left missing.
if exist "%OLD_EXE%" del /f /q "%OLD_EXE%" >nul 2>&1
if exist "%OUT_EXE%" (
  move /y "%OUT_EXE%" "%OLD_EXE%" >nul
  if errorlevel 1 (
    echo [LeafCodePi] Could not move the current exe aside; is another build running?
    if not defined QUIET pause
    exit /b 1
  )
)

echo [LeafCodePi] Compiling LeafCodePi.exe ^(repo root^)...
"%CSC%" /nologo /target:exe /platform:anycpu /out:"%OUT_EXE%" /win32icon:"%LAUNCHER_DIR%\app.ico" "%LAUNCHER_DIR%\Launcher.cs"
if errorlevel 1 (
  echo [LeafCodePi] Compile failed. See the errors above.
  if exist "%OLD_EXE%" move /y "%OLD_EXE%" "%OUT_EXE%" >nul
  if not defined QUIET pause
  exit /b 1
)
if exist "%OLD_EXE%" del /f /q "%OLD_EXE%" >nul 2>&1

echo [LeafCodePi] Built: %OUT_EXE%
echo [LeafCodePi] Next: run scripts\create-shortcut.bat to (re)create the Desktop shortcut.
if not defined QUIET pause
endlocal

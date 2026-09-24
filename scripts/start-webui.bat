@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem Japanese text lives in scripts\setup-messages\*.txt (UTF-8) and is printed with type.
goto :main

:main
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0.."
set "MESSAGE_DIR=%~dp0setup-messages"
title LeafCodePi

if "%LEAFCODE_PI_SETUP_COMPLETE%"=="1" goto :start_host
call :remember_code_page
chcp 65001 >nul 2>&1
echo [LeafCodePi] Starting...

call :check_node
if errorlevel 1 goto :failure
call :install_web
if errorlevel 1 goto :failure
call :install_host
if errorlevel 1 goto :failure
call :restore_code_page
goto :start_host

:start_host
title LeafCodePi
if not defined LEAFCODE_PI_HOST set "LEAFCODE_PI_HOST=tailscale"
if not defined LEAFCODE_PI_PORT set "LEAFCODE_PI_PORT=3010"
if not defined LEAFCODE_PI_MODE set "LEAFCODE_PI_MODE=prod"
if not defined LEAFCODE_PI_RESTART_MAX set "LEAFCODE_PI_RESTART_MAX=5"
set /a RESTARTS=0
cd /d "%~dp0..\host"

rem An unclean host exit (crash or taskkill of node) auto-restarts here; a
rem clean quit (tray Quit, host self-restart) exits 0 and stops the loop.
rem A host that stayed up returns its restart budget (same 60s rule as the
rem WebUI crash budget in host\src\index.js), so a kill hours later still
rem restarts. Killing this cmd/launcher too kills the watchdog with it.
:run_host
for /f %%T in ('node -p "Date.now()"') do set "STARTED_AT=%%T"
call node src\index.js
set ERR=%ERRORLEVEL%
if "%ERR%"=="0" goto :host_done
if "%LEAFCODE_PI_NO_RESTART%"=="1" goto :host_failed
for /f %%T in ('node -p "Date.now()-%STARTED_AT%>=60000?0:1"') do set "SHORT_RUN=%%T"
if "%SHORT_RUN%"=="0" set /a RESTARTS=0
if %RESTARTS% GEQ %LEAFCODE_PI_RESTART_MAX% goto :host_failed
set /a RESTARTS+=1
call :say_restart
%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul
goto :run_host

:say_restart
echo [LeafCodePi] Host exited with code %ERR%; restarting (%RESTARTS%/%LEAFCODE_PI_RESTART_MAX%)...
exit /b 0

:host_failed
echo [LeafCodePi] Host exited with code %ERR%
call :pause_if_interactive
exit /b %ERR%

:host_done
%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul
exit /b 0

:failure
set "FAIL_EXIT=%ERRORLEVEL%"
echo [LeafCodePi] FAILED with exit code %FAIL_EXIT%.
call :say failure
call :restore_code_page
call :pause_if_interactive
exit /b %FAIL_EXIT%

:check_node
rem package.json engines requires Node.js 22.19+. A major-only test accepted
rem 20/21 (and 22.0-22.18) and failed later inside the build with an unclear error.
call :node_version_ok
if not errorlevel 1 exit /b 0
call where winget >nul 2>&1
if errorlevel 1 (
  call :fail 1 "winget was not found." error-1
  exit /b 1
)
echo [LeafCodePi] Installing Node.js LTS...
call winget install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
set "NODE_INSTALL_ERR=%ERRORLEVEL%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :node_version_ok
if not errorlevel 1 exit /b 0
rem winget install reports success when an older LTS is already installed, so an
rem explicit upgrade is the only way to satisfy the version requirement.
call winget upgrade --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :node_version_ok
if not errorlevel 1 exit /b 0
if not "%NODE_INSTALL_ERR%"=="0" (
  call :fail 2 "Node.js could not be installed." error-2
  exit /b 2
)
call :fail 3 "Node.js 22.19 or newer is not available in this command prompt." error-3
exit /b 3

:node_version_ok
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major < 22 || (major === 22 && minor < 19) ? 1 : 0)" 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:install_web
if not exist "%~dp0..\web\node_modules\next" (
  echo [LeafCodePi] Installing web dependencies...
  call npm --prefix "%~dp0..\web" install
  if errorlevel 1 (
    call :fail 5 "web dependencies could not be installed." error-5
    exit /b 5
  )
)
rem The production build lives in the hard-link mirror outside OneDrive
rem (scripts\web-build-mirror.mjs), so this batch cannot check BUILD_ID here.
echo [LeafCodePi] Host will build the WebUI on start if it is missing or stale.
exit /b 0

:install_host
if exist "%~dp0..\host\node_modules\systray2" exit /b 0
echo [LeafCodePi] Installing host dependencies...
call npm --prefix "%~dp0..\host" install
if errorlevel 1 (
  call :fail 6 "host dependencies could not be installed." error-6
  exit /b 6
)
exit /b 0

:fail
set "FAIL_CODE=%~1"
echo [LeafCodePi] ERROR %~1: %~2
call :say %~3
exit /b %FAIL_CODE%

:say
if "%~1"=="" exit /b 0
if not exist "%MESSAGE_DIR%\%~1.txt" exit /b 0
type "%MESSAGE_DIR%\%~1.txt"
exit /b 0

:remember_code_page
set "CP_ORIGINAL="
for /f "tokens=2 delims=:" %%C in ('chcp 2^>nul') do for /f "tokens=1" %%D in ("%%C") do set "CP_ORIGINAL=%%D"
exit /b 0

:restore_code_page
if not defined CP_ORIGINAL exit /b 0
chcp %CP_ORIGINAL% >nul 2>&1
exit /b 0

:pause_if_interactive
if "%LEAFCODE_PI_NONINTERACTIVE%"=="1" exit /b 0
title LeafCodePi
pause
exit /b 0

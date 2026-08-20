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
if not defined LEAFCODE_PI_HOST set "LEAFCODE_PI_HOST=127.0.0.1"
if not defined LEAFCODE_PI_PORT set "LEAFCODE_PI_PORT=3010"
if not defined LEAFCODE_PI_MODE set "LEAFCODE_PI_MODE=prod"
cd /d "%~dp0..\host"
call node src\index.js
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo [LeafCodePi] Host exited with code %ERR%
  call :pause_if_interactive
  exit /b %ERR%
)
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
set "NODE_MAJOR=0"
for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% GEQ 20 exit /b 0
call where winget >nul 2>&1
if errorlevel 1 (
  call :fail 1 "winget was not found." error-1
  exit /b 1
)
echo [LeafCodePi] Installing Node.js LTS...
call winget install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if errorlevel 1 (
  call :fail 2 "Node.js could not be installed." error-2
  exit /b 2
)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
set "NODE_MAJOR=0"
for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% GEQ 20 exit /b 0
call :fail 3 "Node.js is not available in this command prompt." error-3
exit /b 3

:install_web
if not exist "%~dp0..\web\node_modules\next" (
  echo [LeafCodePi] Installing web dependencies...
  call npm --prefix "%~dp0..\web" install
  if errorlevel 1 (
    call :fail 5 "web dependencies could not be installed." error-5
    exit /b 5
  )
)
if exist "%~dp0..\web\.next\BUILD_ID" (
  echo [LeafCodePi] Existing build found; host will rebuild if sources are newer.
) else (
  echo [LeafCodePi] No production build yet; host will run next build on start.
)
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

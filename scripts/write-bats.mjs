import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function writeCrLf(relPath, text, encoding = "utf8") {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const withNl = normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, withNl, { encoding });
}

const startBat = `@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem cmd.exe misparses batch files that contain multi-byte characters.
goto :main

:main
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title LeafCodePi
call "%~dp0scripts\\start-webui.bat"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" exit /b %ERR%
exit /b 0
`;

const startWebuiBat = `@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem Japanese text lives in scripts\\setup-messages\\*.txt (UTF-8) and is printed with type.
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
cd /d "%~dp0..\\host"
call node src\\index.js
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo [LeafCodePi] Host exited with code %ERR%
  call :pause_if_interactive
  exit /b %ERR%
)
%SystemRoot%\\System32\\ping.exe -n 4 127.0.0.1 >nul
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
if exist "%ProgramFiles%\\nodejs\\node.exe" set "PATH=%ProgramFiles%\\nodejs;%PATH%"
set "NODE_MAJOR=0"
for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% GEQ 20 exit /b 0
call :fail 3 "Node.js is not available in this command prompt." error-3
exit /b 3

:install_web
if not exist "%~dp0..\\web\\node_modules\\next" (
  echo [LeafCodePi] Installing web dependencies...
  call npm --prefix "%~dp0..\\web" install
  if errorlevel 1 (
    call :fail 5 "web dependencies could not be installed." error-5
    exit /b 5
  )
)
rem The production build lives in the hard-link mirror outside OneDrive
rem (scripts\\web-build-mirror.mjs), so this batch cannot check BUILD_ID here.
echo [LeafCodePi] Host will build the WebUI on start if it is missing or stale.
exit /b 0

:install_host
if exist "%~dp0..\\host\\node_modules\\systray2" exit /b 0
echo [LeafCodePi] Installing host dependencies...
call npm --prefix "%~dp0..\\host" install
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
if not exist "%MESSAGE_DIR%\\%~1.txt" exit /b 0
type "%MESSAGE_DIR%\\%~1.txt"
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
`;

const shortcutBat = `@echo off
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
type "%~dp0shortcut-messages\\success.txt"
if defined CP_ORIGINAL chcp %CP_ORIGINAL% >nul 2>&1
pause
endlocal
`;

writeCrLf("start.bat", startBat, "ascii");
writeCrLf("scripts/start-webui.bat", startWebuiBat, "ascii");
writeCrLf("scripts/create-shortcut.bat", shortcutBat, "ascii");

writeCrLf(
  "scripts/setup-messages/error-1.txt",
  "[LeafCodePi] wingetが見つかりません。\n[LeafCodePi] 復旧案内: Microsoft Storeから「アプリインストーラー」を導入してください。",
);
writeCrLf(
  "scripts/setup-messages/error-2.txt",
  "[LeafCodePi] Node.jsを導入できませんでした。\n[LeafCodePi] 復旧案内: https://nodejs.org から LTS を手動導入してください。",
);
writeCrLf(
  "scripts/setup-messages/error-3.txt",
  "[LeafCodePi] このコマンドプロンプトで Node.js が使えません。\n[LeafCodePi] 復旧案内: 新しいコマンドプロンプトを開いて start.bat を再実行してください。",
);
writeCrLf(
  "scripts/setup-messages/error-5.txt",
  "[LeafCodePi] web の依存関係を導入できませんでした。\n[LeafCodePi] 復旧案内: ネットワークを確認し、npm --prefix web install を実行してください。",
);
writeCrLf(
  "scripts/setup-messages/error-6.txt",
  "[LeafCodePi] host の依存関係を導入できませんでした。\n[LeafCodePi] 復旧案内: ネットワークを確認し、npm --prefix host install を実行してください。",
);
writeCrLf(
  "scripts/setup-messages/failure.txt",
  "[LeafCodePi] 起動に失敗しました。上の ERROR 行を確認してください。",
);
writeCrLf(
  "scripts/shortcut-messages/success.txt",
  "[LeafCodePi] デスクトップにショートカットを作成しました。\n[LeafCodePi] タスクバーへピン留めする場合は、ショートカットを右クリックしてください。",
);

console.log("wrote bat and message files");

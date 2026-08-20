@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem Start llama-server for LeafCodePi / Pi Coding Agent (OpenAI-compatible).
rem
rem Override via env (host passes these from Settings > Engine > llama-server):
rem   LLAMA_SERVER_BIN, MODEL_DIR, MODEL_FILE, LLAMA_SERVER_HOST,
rem   CONTEXT_LENGTH, PARALLEL, REASONING_EFFORT, LLAMA_SERVER_LOG
rem
rem If MODEL_FILE is empty: router mode (--models-dir), then load a model.
rem If MODEL_FILE is set: single-model mode (-m).
rem Default port 8081 (shared with LeafCode llama-server).
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "SERVER_PORT=8081"
if not defined LLAMA_SERVER_HOST set "LLAMA_SERVER_HOST=127.0.0.1"
if not defined MODEL_DIR set "MODEL_DIR=C:\Users\Daichi\models\llm"
if not defined MODEL_FILE set "MODEL_FILE="
if not defined REASONING_EFFORT set "REASONING_EFFORT=low"
if not defined CONTEXT_LENGTH set "CONTEXT_LENGTH=32768"
if not defined PARALLEL set "PARALLEL=1"
if not defined UBATCH set "UBATCH=512"
if not defined LLAMA_SERVER_BIN set "LLAMA_SERVER_BIN=C:\tools\llama.cpp\llama-server.exe"
set "MODEL_ALIAS="

if /i "%~1"=="/dry-run" (
  echo [DRY-RUN] binary=%LLAMA_SERVER_BIN%
  echo [DRY-RUN] modelDir=%MODEL_DIR%
  echo [DRY-RUN] modelFile=%MODEL_FILE%
  echo [DRY-RUN] context=%CONTEXT_LENGTH%
  echo [DRY-RUN] parallel=%PARALLEL%
  echo [DRY-RUN] effort=%REASONING_EFFORT%
  echo [DRY-RUN] endpoint=http://127.0.0.1:%SERVER_PORT%/v1
  exit /b 0
)

if not exist "%LLAMA_SERVER_BIN%" (
  echo [FAIL] llama-server.exe not found at:
  echo [FAIL]   %LLAMA_SERVER_BIN%
  echo [FAIL] Download a release from
  echo [FAIL]   https://github.com/ggml-org/llama.cpp/releases
  echo [FAIL] and extract it under C:\tools\llama.cpp, or set LLAMA_SERVER_BIN.
  exit /b 1
)

if not defined LLAMA_SERVER_LOG set "LLAMA_SERVER_LOG=%APPDATA%\leafcode-pi\llama-server.log"
for /f "delims=" %%D in ("%LLAMA_SERVER_LOG%") do set "LLAMA_LOG_DIR=%%~dpD"
if not exist "%LLAMA_LOG_DIR%" mkdir "%LLAMA_LOG_DIR%" >nul 2>&1

netstat -ano | findstr /r /c:"%LLAMA_SERVER_HOST%:%SERVER_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo [llama-server] Already listening on port %SERVER_PORT%; keeping it.
  goto :ready
)

if defined MODEL_FILE if not "%MODEL_FILE%"=="" goto :single_model
goto :router_mode

:single_model
set "MODEL_PATH=%MODEL_DIR%\%MODEL_FILE%"
if not exist "%MODEL_PATH%" (
  echo [FAIL] Model not found at:
  echo [FAIL]   %MODEL_PATH%
  exit /b 2
)
rem Stable OpenAI model id (basename without .gguf) so clients need not send the full path.
for %%F in ("%MODEL_FILE%") do set "MODEL_ALIAS=%%~nF"
echo [llama-server] Starting single-model ^(alias %MODEL_ALIAS%, context %CONTEXT_LENGTH%, parallel %PARALLEL%^)...
start "llama-server" /min cmd.exe /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -c %CONTEXT_LENGTH% -np %PARALLEL% -ngl 999 -ub %UBATCH% --jinja --chat-template-kwargs "{\"reasoning_effort\":\"%REASONING_EFFORT%\"}" >> "%LLAMA_SERVER_LOG%" 2>&1"
goto :wait_health

:router_mode
if not exist "%MODEL_DIR%" (
  echo [FAIL] MODEL_DIR not found:
  echo [FAIL]   %MODEL_DIR%
  exit /b 2
)
echo [llama-server] Starting router mode ^(models-dir, context %CONTEXT_LENGTH%^)...
rem Do not pass --no-models-autoload: we want a model available for chat after start.
rem ensure-loaded.mjs still POST /models/load if the catalog stays unloaded.
start "llama-server" /min cmd.exe /c ""%LLAMA_SERVER_BIN%" --models-dir "%MODEL_DIR%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -c %CONTEXT_LENGTH% -np %PARALLEL% -ngl 999 -ub %UBATCH% --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"
goto :wait_health

:wait_health
echo [llama-server] Waiting for the server to become healthy...
set "READY="
for /l %%I in (1,1,60) do (
  if not defined READY (
    ping -n 3 127.0.0.1 >nul
    curl -s -m 3 "http://127.0.0.1:%SERVER_PORT%/health" 2>nul | findstr /c:"\"status\":\"ok\"" >nul
    if not errorlevel 1 set "READY=1"
  )
)
if not defined READY (
  echo [FAIL] Server did not become healthy within 120s.
  exit /b 3
)

:ready
echo [llama-server] Ensuring a model is loaded...
if not defined MODEL_ALIAS if defined MODEL_FILE if not "%MODEL_FILE%"=="" (
  for %%F in ("%MODEL_FILE%") do set "MODEL_ALIAS=%%~nF"
)
call node "%~dp0llama-server-ensure-loaded.mjs" %SERVER_PORT% "%MODEL_ALIAS%"
if errorlevel 1 (
  echo [WARN] Model auto-load reported an error; check %LLAMA_SERVER_LOG%
)
echo [OK] llama-server is ready at http://127.0.0.1:%SERVER_PORT%/v1
endlocal
exit /b 0

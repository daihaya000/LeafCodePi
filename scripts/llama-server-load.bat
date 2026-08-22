@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem Start llama-server for LeafCodePi / Pi Coding Agent (OpenAI-compatible).
rem
rem Override via env (host passes these from Settings > Engine > llama-server):
rem   LLAMA_SERVER_BIN, MODEL_DIR, MODEL_FILE, LLAMA_SERVER_HOST,
rem   CONTEXT_LENGTH, PARALLEL, REASONING_EFFORT, LLAMA_SERVER_LOG,
rem   SAMPLING_TEMP, TOP_P, TOP_K
rem
rem If MODEL_FILE is empty: router mode (--models-dir), then load a model.
rem If MODEL_FILE is set: single-model mode (-m).
rem Default port 8081 (shared with LeafCode llama-server).
rem Sampling defaults follow Ornith-1.5 coding recommendations (temp 0.6 /
rem top-p 0.95 / top-k 20). Leave REASONING_EFFORT empty for GGUFs whose chat
rem template has no reasoning_effort kwarg (e.g. Ornith-1.5).
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "SERVER_PORT=8081"
if not defined LLAMA_SERVER_HOST set "LLAMA_SERVER_HOST=127.0.0.1"
if not defined MODEL_DIR set "MODEL_DIR=C:\Users\Daichi\models\llm"
if not defined MODEL_FILE set "MODEL_FILE="
if not defined REASONING_EFFORT set "REASONING_EFFORT=low"
if not defined CONTEXT_LENGTH set "CONTEXT_LENGTH=32768"
if not defined PARALLEL set "PARALLEL=1"
if not defined UBATCH set "UBATCH=2048"
if not defined SAMPLING_TEMP set "SAMPLING_TEMP=0.6"
if not defined TOP_P set "TOP_P=0.95"
if not defined TOP_K set "TOP_K=20"
if not defined LLAMA_SERVER_BIN set "LLAMA_SERVER_BIN=C:\tools\llama.cpp\llama-server.exe"
rem KV cache types (f16 default). q8_0 halves KV VRAM at ~0 quality cost and
rem was measurably fine on both local models (Ornith-1.5-35B-A3B, Qwen3.8-27B).
rem Leave empty to use llama.cpp defaults.
if not defined CT_K set "CT_K="
if not defined CT_V set "CT_V="
set "CACHE_ARGS="
if not "%CT_K%"=="" set "CACHE_ARGS=%CACHE_ARGS% --cache-type-k %CT_K%"
if not "%CT_V%"=="" set "CACHE_ARGS=%CACHE_ARGS% --cache-type-v %CT_V%"
rem Speculative decoding type (e.g. draft-mtp). Leave empty for GGUFs without
rem MTP tensors (e.g. Ornith-1.5 AtomicChat builds) - they fail to load with
rem --spec-type draft-mtp. Qwen3.5-class dense builds (nextn_predict_layers=1,
rem e.g. Qwen3.8-27B) gain ~10x decode speed from draft-mtp.
if not defined SPEC_TYPE set "SPEC_TYPE="
set "SPEC_ARGS="
if not "%SPEC_TYPE%"=="" set "SPEC_ARGS=--spec-type %SPEC_TYPE%"
rem Vision projector (mmproj) for image input. MODEL_DIR-relative path, e.g.
rem "Ornith-1.5-35B-A3B-GGUF\mmproj.gguf". Empty = text-only (fastest start).
if not defined MMPROJ_FILE set "MMPROJ_FILE="
set "MMPROJ_ARGS="
if defined MODEL_FILE if not "%MODEL_FILE%"=="" if not "%MMPROJ_FILE%"=="" set "MMPROJ_ARGS=--mmproj %MODEL_DIR%\%MMPROJ_FILE%"
rem Shared perf + sampling flags: FlashAttention on (Ornith-1.5 / Qwen3 recommended),
rem server-side sampling defaults (clients may still override per request).
rem ubatch 2048: +20% prompt processing on Vulkan vs 512 (measured, tg unchanged).
set "PERF_ARGS=-fa on --temp %SAMPLING_TEMP% --top-p %TOP_P% --top-k %TOP_K% -ub %UBATCH%"
set "MODEL_ALIAS="

if /i "%~1"=="/dry-run" (
  echo [DRY-RUN] binary=%LLAMA_SERVER_BIN%
  echo [DRY-RUN] modelDir=%MODEL_DIR%
  echo [DRY-RUN] modelFile=%MODEL_FILE%
  echo [DRY-RUN] context=%CONTEXT_LENGTH%
  echo [DRY-RUN] parallel=%PARALLEL%
  echo [DRY-RUN] effort=%REASONING_EFFORT%
  echo [DRY-RUN] sampling=temp %SAMPLING_TEMP% top-p %TOP_P% top-k %TOP_K%
  echo [DRY-RUN] spec=%SPEC_TYPE%
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
rem Ornith-1.5 and other GGUFs without a reasoning_effort template kwarg must
rem start with REASONING_EFFORT empty (plain mode).
if not "%REASONING_EFFORT%"=="" set "LAUNCH_MODE=single_kwargs"
if "%REASONING_EFFORT%"=="" set "LAUNCH_MODE=single_plain"
goto :launch

:router_mode
if not exist "%MODEL_DIR%" (
  echo [FAIL] MODEL_DIR not found:
  echo [FAIL]   %MODEL_DIR%
  exit /b 2
)
echo [llama-server] Starting router mode ^(models-dir, context %CONTEXT_LENGTH%^)...
rem Do not pass --no-models-autoload: we want a model available for chat after start.
rem ensure-loaded.mjs still POST /models/load if the catalog stays unloaded.
set "LAUNCH_MODE=router"
goto :launch

:launch
if "%LAUNCH_MODE%"=="single_kwargs" start "llama-server" /min cmd.exe /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -c %CONTEXT_LENGTH% -np %PARALLEL% -ngl 999 %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %MMPROJ_ARGS% --jinja --chat-template-kwargs "{\"reasoning_effort\":\"%REASONING_EFFORT%\"}" >> "%LLAMA_SERVER_LOG%" 2>&1"
if "%LAUNCH_MODE%"=="single_plain" start "llama-server" /min cmd.exe /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -c %CONTEXT_LENGTH% -np %PARALLEL% -ngl 999 %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %MMPROJ_ARGS% --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"
if "%LAUNCH_MODE%"=="router" start "llama-server" /min cmd.exe /c ""%LLAMA_SERVER_BIN%" --models-dir "%MODEL_DIR%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -c %CONTEXT_LENGTH% -np %PARALLEL% -ngl 999 %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %MMPROJ_ARGS% --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"

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
if defined READY goto :ready
rem One automatic retry: right after a kill, VRAM may still be releasing and
rem llama-server can die before it logs anything.
if defined LAUNCH_RETRIED (
  echo [FAIL] Server did not become healthy within 120s (retry exhausted).
  exit /b 3
)
set "LAUNCH_RETRIED=1"
echo [llama-server] Not healthy; retrying once ^(killing leftovers, waiting for VRAM release^)...
taskkill /F /IM llama-server.exe >nul 2>&1
ping -n 21 127.0.0.1 >nul
goto :launch

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

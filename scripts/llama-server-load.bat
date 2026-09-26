@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem Start llama-server for LeafCodePi / Pi Coding Agent (OpenAI-compatible).
rem
rem Override via env (host passes these from Settings > Engine > llama-server):
rem   LLAMA_SERVER_BIN, MODEL_DIR, MODEL_FILE, LLAMA_SERVER_HOST,
rem   CONTEXT_LENGTH, PARALLEL, REASONING_EFFORT, LLAMA_SERVER_LOG,
rem   THREADS, THREADS_BATCH, BATCH_SIZE, UBATCH, SAMPLING_TEMP, TOP_P, TOP_K, MIN_P, SAMPLERS,
rem   SAMPLING_SEED, SAMPLING_REPEAT_LAST_N, SAMPLING_REPEAT_PENALTY,
rem   SAMPLING_DRY_MULTIPLIER, SAMPLING_DRY_BASE, SAMPLING_DRY_ALLOWED_LENGTH,
rem   SAMPLING_DRY_PENALTY_LAST_N, REASONING_BUDGET, REASONING_BUDGET_MESSAGE,
rem   CACHE_REUSE (0 = disabled; default 256),
rem   GPU_DEVICE, IMAGE_MIN_TOKENS, IMAGE_MAX_TOKENS (empty = omit image flags),
rem   LORA_FILE (modelDir-relative LoRA adapter GGUF, empty = no adapter)
rem
rem If MODEL_FILE is empty: router mode (--models-dir), then load a model.
rem If MODEL_FILE is set: single-model mode (-m).
rem Default port 8081 (shared with LeafCode llama-server).
rem Qwen3.8 single-model launches use its official thinking sampler defaults.
rem Other models retain the existing sampler. REASONING_EFFORT is passed as
rem --reasoning-effort; leave it empty for GGUFs whose chat template has no
rem reasoning_effort kwarg (e.g. Ornith-1.5), which then uses plain mode.
rem Never caret-escape quotes inside the launch lines below: within
rem `cmd /s /c "..."` an escaped quote unbalances the quoting and the log
rem redirect is passed to llama-server as an argument (`invalid argument: >>`),
rem so the server exits without ever writing a line to the log.
setlocal enabledelayedexpansion
cd /d "%~dp0.."

if not defined SERVER_PORT set "SERVER_PORT=8081"
if not defined LLAMA_SERVER_HOST set "LLAMA_SERVER_HOST=127.0.0.1"
if not defined MODEL_DIR set "MODEL_DIR=C:\Users\Daichi\models\llm"
if not defined MODEL_FILE set "MODEL_FILE="
if not defined REASONING_EFFORT set "REASONING_EFFORT=low"
if "%LEAFCODE_PI_EMPTY_EFFORT%"=="1" set "REASONING_EFFORT="
if not defined CONTEXT_LENGTH set "CONTEXT_LENGTH=32768"
if not defined PARALLEL set "PARALLEL=1"
if not defined THREADS set "THREADS=8"
if not defined THREADS_BATCH set "THREADS_BATCH=16"
if not defined BATCH_SIZE set "BATCH_SIZE=2048"
rem ubatch 512 measured the same prefill as 2048 on the R9700 and keeps
rem several GB of VRAM free, which stops WDDM from spilling to system RAM.
if not defined UBATCH set "UBATCH=512"
rem https://huggingface.co/Qwen/Qwen3.8-27B (thinking mode).
rem Apply only to selected Qwen3.8 models, not router mode or other families.
rem Explicit environment overrides still win; non-thinking requests should
rem provide their own sampler (temp 0.7, top-p 0.8, presence penalty 1.5).
rem Keep small images at their native resolution; IMAGE_MIN_TOKENS is an
rem explicit opt-in for grounding tasks, not the Qwen3.8 default.
echo(%MODEL_FILE%| findstr /i /c:"qwen3.8" /c:"qwen3_8" >nul
if not errorlevel 1 (
  if not defined SAMPLING_TEMP set "SAMPLING_TEMP=1.0"
  if not defined MIN_P set "MIN_P=0.0"
  if not defined SAMPLING_REPEAT_PENALTY set "SAMPLING_REPEAT_PENALTY=1.0"
  if not defined SAMPLING_DRY_MULTIPLIER set "SAMPLING_DRY_MULTIPLIER=0.0"
  rem Limit the 248k-vocabulary penalty scan to the top-k candidates.
  if not defined SAMPLERS set "SAMPLERS=top_k;penalties;dry;top_n_sigma;typ_p;top_p;min_p;xtc;temperature"
)
if not defined SAMPLING_TEMP set "SAMPLING_TEMP=0.6"
if not defined MIN_P set "MIN_P=0.05"
if not defined TOP_P set "TOP_P=0.95"
if not defined TOP_K set "TOP_K=20"
if not defined SAMPLING_SEED set "SAMPLING_SEED=42"
if not defined SAMPLING_REPEAT_LAST_N set "SAMPLING_REPEAT_LAST_N=256"
if not defined SAMPLING_REPEAT_PENALTY set "SAMPLING_REPEAT_PENALTY=1.03"
if not defined SAMPLING_DRY_MULTIPLIER set "SAMPLING_DRY_MULTIPLIER=0.35"
if not defined SAMPLING_DRY_BASE set "SAMPLING_DRY_BASE=1.75"
if not defined SAMPLING_DRY_ALLOWED_LENGTH set "SAMPLING_DRY_ALLOWED_LENGTH=4"
if not defined SAMPLING_DRY_PENALTY_LAST_N set "SAMPLING_DRY_PENALTY_LAST_N=2048"
if not defined REASONING_BUDGET set "REASONING_BUDGET=1536"
if not defined REASONING_BUDGET_MESSAGE set "REASONING_BUDGET_MESSAGE=Reasoning limit reached. Stop analysis and provide the best concise final answer now."
rem GPU pinning. Inference must never fall back to the CPU or to the iGPU
rem (whose VRAM is shared system RAM): --device pins the single GPU, --gpu-layers
rem all plus --n-cpu-moe 0 keep every layer on it, and --fit off stops llama.cpp
rem from silently shrinking layers or context to fit. Do not re-add --n-cpu-ffn:
rem llama-server b10488 rejects it ("invalid argument"), which aborts the launch.
rem Too little VRAM must fail the launch instead of degrading to CPU speed.
rem Override with GPU_DEVICE (for example CUDA0) when the GPU index differs.
if not defined GPU_DEVICE set "GPU_DEVICE=Vulkan0"
set "LLAMA_SERVER_BIN_EXPLICIT="
if defined LLAMA_SERVER_BIN set "LLAMA_SERVER_BIN_EXPLICIT=1"
if not defined LLAMA_SERVER_BIN set "LLAMA_SERVER_BIN=C:\tools\llama.cpp\llama-server.exe"
rem Ternary Bonsai uses PrismML-only GGML type 143. Keep an explicit binary
rem override untouched; otherwise prefer the most recently installed PrismML
rem Vulkan runtime under C:\tools so selecting the Bonsai preset works out
rem of the box (/o:d lists oldest first, so the loop keeps the newest).
set "PRISMML_BONSAI_BIN="
if not defined LLAMA_SERVER_BIN_EXPLICIT (
  echo(%MODEL_FILE%| findstr /i /c:"bonsai" >nul
  if not errorlevel 1 (
    for /f "delims=" %%D in ('dir /b /ad /o:d "C:\tools\llama-prism-*-vulkan" 2^>nul') do (
      if exist "C:\tools\%%D\llama-server.exe" set "PRISMML_BONSAI_BIN=C:\tools\%%D\llama-server.exe"
    )
    rem Without a PrismML runtime the stock binary fails late with
    rem "invalid ggml type 143". Fail fast instead; dry-run only warns so
    rem config checks stay portable across machines.
    if not defined PRISMML_BONSAI_BIN (
      echo [FAIL] Bonsai model needs a PrismML llama.cpp Vulkan runtime.
      echo [FAIL] Install one under C:\tools ^(for example llama-prism-*-vulkan^) or set LLAMA_SERVER_BIN.
      if /i not "%~1"=="/dry-run" exit /b 1
    )
  )
)
if defined PRISMML_BONSAI_BIN (
  set "LLAMA_SERVER_BIN=!PRISMML_BONSAI_BIN!"
  echo [llama-server] Bonsai model detected; selecting PrismML Vulkan runtime.
  echo [llama-server]   !LLAMA_SERVER_BIN!
)
rem KV cache types (f16 default). q8_0 reduces attention KV memory, not all VRAM.
rem Long-context quality still needs workload-specific validation.
rem Explicit f16 matches the Linux Vulkan profile; q8_0 is useful when VRAM is tight.
if not defined CT_K set "CT_K=f16"
if not defined CT_V set "CT_V=f16"
rem Reuse stable prompt-cache chunks when a turn appends history; 0 disables.
if not defined CACHE_REUSE set "CACHE_REUSE=256"
set "CACHE_ARGS="
if not "%CT_K%"=="" set "CACHE_ARGS=%CACHE_ARGS% --cache-type-k %CT_K%"
if not "%CT_V%"=="" set "CACHE_ARGS=%CACHE_ARGS% --cache-type-v %CT_V%"
if not "%CACHE_REUSE%"=="" set "CACHE_ARGS=%CACHE_ARGS% --cache-reuse %CACHE_REUSE%"
rem Speculative decoding type (e.g. draft-mtp). Leave empty for GGUFs without
rem MTP tensors (e.g. Ornith-1.5 AtomicChat builds) - they fail to load with
rem --spec-type draft-mtp. Gains depend on model, backend and acceptance rate;
rem do not infer MTP tensor availability or a fixed speedup from a filename.
if not defined SPEC_TYPE set "SPEC_TYPE="
rem draft-mtp depth. Measured 2026-09-21 on this box (R9700 / Vulkan b11069 /
rem Qwen3.8-27B Q4_K_S, 30k prompt): n-max 2 = 49.5 t/s, 3 = 53.9 t/s,
rem 4 = 34.7 t/s. Keep 3; re-measure after a build or model change.
if not defined DRAFT_MAX set "DRAFT_MAX=3"
set "SPEC_ARGS="
if not "%SPEC_TYPE%"=="" set "SPEC_ARGS=--spec-type %SPEC_TYPE% --spec-draft-n-max %DRAFT_MAX%"
rem Vision projector (mmproj) for image input. MODEL_DIR-relative path, e.g.
rem "Ornith-1.5-35B-A3B-GGUF\mmproj.gguf". Empty = text-only (fastest start).
if not defined MMPROJ_FILE set "MMPROJ_FILE="
set "MMPROJ_PATH="
if defined MODEL_FILE if not "%MODEL_FILE%"=="" if not "%MMPROJ_FILE%"=="" set "MMPROJ_PATH=%MODEL_DIR%\%MMPROJ_FILE%"
rem Shared perf + sampling flags: match the Linux Vulkan profile while keeping
rem GPU_DEVICE overridable for Windows CUDA/Vulkan builds; see the pinning block above.
set "DEVICE_ARGS="
if not "%GPU_DEVICE%"=="" set "DEVICE_ARGS=--device %GPU_DEVICE%"
set "REASONING_ARGS=--reasoning-budget %REASONING_BUDGET% --reasoning-budget-message "%REASONING_BUDGET_MESSAGE%""
rem Image token controls are opt-in for Qwen3.8; Bonsai uses a 1024-token
rem maximum on Vulkan/CPU by default. Both are overridable.
set "IMAGE_TOKENS_ARGS="
if defined IMAGE_MIN_TOKENS if not "%IMAGE_MIN_TOKENS%"=="" set "IMAGE_TOKENS_ARGS=%IMAGE_TOKENS_ARGS% --image-min-tokens %IMAGE_MIN_TOKENS%"
echo(%MODEL_FILE%| findstr /i /c:"bonsai" /c:"orcabonsai" >nul
if not errorlevel 1 if not defined IMAGE_MAX_TOKENS set "IMAGE_MAX_TOKENS=1024"
if defined IMAGE_MAX_TOKENS if not "%IMAGE_MAX_TOKENS%"=="" if not "%IMAGE_MAX_TOKENS%"=="0" set "IMAGE_TOKENS_ARGS=%IMAGE_TOKENS_ARGS% --image-max-tokens %IMAGE_MAX_TOKENS%"
rem LoRA adapter. The path is relative to MODEL_DIR, like MMPROJ_FILE.
if not defined LORA_FILE set "LORA_FILE="
set "LORA_PATH="
if defined MODEL_FILE if not "%MODEL_FILE%"=="" if not "%LORA_FILE%"=="" set "LORA_PATH=%MODEL_DIR%\%LORA_FILE%"
set "LORA_ARGS="
if defined LORA_PATH set LORA_ARGS=--lora "%LORA_PATH%"
set "SAMPLER_ARGS="
if defined SAMPLERS set SAMPLER_ARGS=--samplers "%SAMPLERS%"
set "PERF_ARGS=--split-mode none --fit off --no-host --threads %THREADS% --threads-batch %THREADS_BATCH% --gpu-layers all --n-cpu-moe 0 --flash-attn on --ctx-size %CONTEXT_LENGTH% --batch-size %BATCH_SIZE% --ubatch-size %UBATCH% --temp %SAMPLING_TEMP% --top-p %TOP_P% --top-k %TOP_K% --min-p %MIN_P% --seed %SAMPLING_SEED% --repeat-last-n %SAMPLING_REPEAT_LAST_N% --repeat-penalty %SAMPLING_REPEAT_PENALTY% --dry-multiplier %SAMPLING_DRY_MULTIPLIER% --dry-base %SAMPLING_DRY_BASE% --dry-allowed-length %SAMPLING_DRY_ALLOWED_LENGTH% --dry-penalty-last-n %SAMPLING_DRY_PENALTY_LAST_N% %SAMPLER_ARGS% %REASONING_ARGS% %IMAGE_TOKENS_ARGS% --metrics"
set "MODEL_ALIAS="

if /i "%~1"=="/dry-run" (
  echo [DRY-RUN] binary=%LLAMA_SERVER_BIN%
  echo [DRY-RUN] modelDir=%MODEL_DIR%
  echo [DRY-RUN] modelFile=%MODEL_FILE%
  echo [DRY-RUN] context=%CONTEXT_LENGTH%
  echo [DRY-RUN] parallel=%PARALLEL%
  echo [DRY-RUN] effort=%REASONING_EFFORT%
  echo [DRY-RUN] sampling=temp %SAMPLING_TEMP% top-p %TOP_P% top-k %TOP_K% min-p %MIN_P% repeat %SAMPLING_REPEAT_PENALTY% dry %SAMPLING_DRY_MULTIPLIER%
  echo [DRY-RUN] perf=%PERF_ARGS%
  echo [DRY-RUN] cache=%CACHE_ARGS%
  echo [DRY-RUN] device=%DEVICE_ARGS%
  echo [DRY-RUN] spec=%SPEC_TYPE% draft-max=%DRAFT_MAX%
  echo [DRY-RUN] image=%IMAGE_TOKENS_ARGS%
  echo [DRY-RUN] lora=%LORA_ARGS%
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
if defined MMPROJ_PATH goto :launch_with_mmproj
if "%LAUNCH_MODE%"=="single_kwargs" start "llama-server" /min cmd.exe /s /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -np %PARALLEL% %DEVICE_ARGS% %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %LORA_ARGS% --jinja --reasoning-effort %REASONING_EFFORT% >> "%LLAMA_SERVER_LOG%" 2>&1"
if "%LAUNCH_MODE%"=="single_plain" start "llama-server" /min cmd.exe /s /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -np %PARALLEL% %DEVICE_ARGS% %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %LORA_ARGS% --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"
if "%LAUNCH_MODE%"=="router" start "llama-server" /min cmd.exe /s /c ""%LLAMA_SERVER_BIN%" --models-dir "%MODEL_DIR%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -np %PARALLEL% %DEVICE_ARGS% %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %LORA_ARGS% --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"
goto :wait_health

:launch_with_mmproj
if "%LAUNCH_MODE%"=="single_kwargs" start "llama-server" /min cmd.exe /s /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -np %PARALLEL% %DEVICE_ARGS% %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %LORA_ARGS% --mmproj "%MMPROJ_PATH%" --jinja --reasoning-effort %REASONING_EFFORT% >> "%LLAMA_SERVER_LOG%" 2>&1"
if "%LAUNCH_MODE%"=="single_plain" start "llama-server" /min cmd.exe /s /c ""%LLAMA_SERVER_BIN%" -m "%MODEL_PATH%" --alias "%MODEL_ALIAS%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -np %PARALLEL% %DEVICE_ARGS% %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %LORA_ARGS% --mmproj "%MMPROJ_PATH%" --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"
if "%LAUNCH_MODE%"=="router" start "llama-server" /min cmd.exe /s /c ""%LLAMA_SERVER_BIN%" --models-dir "%MODEL_DIR%" --host %LLAMA_SERVER_HOST% --port %SERVER_PORT% -np %PARALLEL% %DEVICE_ARGS% %PERF_ARGS% %CACHE_ARGS% %SPEC_ARGS% %LORA_ARGS% --mmproj "%MMPROJ_PATH%" --jinja >> "%LLAMA_SERVER_LOG%" 2>&1"

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
echo [llama-server] Not healthy; retrying once ^(waiting for VRAM release^)...
rem Never kill an arbitrary process that may have claimed the port during the
rem wait. If a listener appeared, leave it untouched and fail safely.
netstat -ano | findstr /r /c:":%SERVER_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo [FAIL] Port %SERVER_PORT% became occupied; refusing to kill an unrelated listener.
  exit /b 3
)
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

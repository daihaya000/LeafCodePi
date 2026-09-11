import os
import runpy
import sys
from pathlib import Path

log_path = Path(os.environ.get("LEAFCODE_TTS_LOG", r"C:\Users\Daichi\AppData\Local\Temp\leafcode-tts-server.log"))
log_path.parent.mkdir(parents=True, exist_ok=True)
log = log_path.open("w", encoding="utf-8", buffering=1)
sys.stdout = log
sys.stderr = log
print("launcher_start", flush=True)
for key in (
    "PORT",
    "QWEN3_TTS_DEVICE",
    "QWEN3_TTS_MODEL",
    "QWEN3_TTS_REF_AUDIO",
    "QWEN3_TTS_REF_TEXT",
):
    print(f"{key}={os.environ.get(key)}", flush=True)
server = Path(__file__).with_name("server.py")
print("server", server, flush=True)
runpy.run_path(str(server), run_name="__main__")

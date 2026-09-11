#!/usr/bin/env python3
"""Minimal Qwen3-TTS HTTP front for leafcode-tts.

Endpoints:
  GET  /v1/health
  POST /tts
  POST /v1/tts
  POST /v1/audio/speech   (OpenAI-compatible: {input, voice, response_format})

All synthesis routes return WAV bytes when qwen-tts is installed.
Without the package they return HTTP 501 so the LeafCode client can fall back.

Env:
  QWEN3_TTS_MODEL     default Qwen/Qwen3-TTS-12Hz-0.6B-Base
  QWEN3_TTS_DEVICE    default cuda:0 (ROCm builds usually still use cuda:0)
  QWEN3_TTS_REF_AUDIO required for Base voice-clone models
  QWEN3_TTS_REF_TEXT  transcript of the reference clip
  QWEN3_TTS_LANGUAGE  default Japanese
  PORT                default 8080
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

MODEL_ID = os.environ.get("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
DEVICE = os.environ.get("QWEN3_TTS_DEVICE", "").strip()
REF_AUDIO = os.environ.get("QWEN3_TTS_REF_AUDIO", "").strip()
REF_TEXT = os.environ.get("QWEN3_TTS_REF_TEXT", "").strip()
DEFAULT_LANGUAGE = os.environ.get("QWEN3_TTS_LANGUAGE", "Japanese")
PORT = int(os.environ.get("PORT", "8080"))

_model = None
_load_error: str | None = None
_resolved_device: str | None = None
_prompt_cache = None
_busy = threading.Lock()


def _pick_device() -> str:
    """Prefer discrete R9700/Radeon AI PRO over the iGPU that often sits at cuda:0."""
    if DEVICE:
        return DEVICE
    import torch

    if not torch.cuda.is_available() or torch.cuda.device_count() == 0:
        return "cpu"
    preferred = []
    fallback = []
    for index in range(torch.cuda.device_count()):
        name = (torch.cuda.get_device_name(index) or "").lower()
        target = f"cuda:{index}"
        if any(token in name for token in ("r9700", "radeon ai pro", "rx 79", "rx 90", "gfx1201", "gfx1100")):
            preferred.append(target)
        elif "graphics" in name and "radeon" in name:
            fallback.append(target)
        else:
            preferred.append(target)
    return (preferred or fallback or ["cuda:0"])[0]


def _load_model():
    global _model, _load_error, _resolved_device
    if _model is not None or _load_error is not None:
        return _model
    try:
        import torch
        from qwen_tts import Qwen3TTSModel

        _resolved_device = _pick_device()
        # ponytail: float32 default because MIOpen conv1d fails in bf16/fp16 on
        # Windows gfx1201 (miopenStatusUnknownError). Set QWEN3_TTS_DTYPE=bfloat16
        # once MIOpen supports it.
        dtype_name = os.environ.get("QWEN3_TTS_DTYPE", "float32")
        kwargs: dict[str, Any] = {
            "device_map": _resolved_device,
            "dtype": getattr(torch, dtype_name),
        }
        try:
            _model = Qwen3TTSModel.from_pretrained(MODEL_ID, attn_implementation="flash_attention_2", **kwargs)
        except Exception:
            _model = Qwen3TTSModel.from_pretrained(MODEL_ID, **kwargs)
        return _model
    except Exception as exc:  # pragma: no cover - depends on local GPU stack
        _load_error = f"{type(exc).__name__}: {exc}"
        return None


def _pcm16_wav(samples, sample_rate: int) -> bytes:
    import array

    if hasattr(samples, "tolist"):
        values = samples.tolist()
    else:
        values = list(samples)
    # float [-1,1] or already int16
    buf = array.array("h")
    for value in values:
        if isinstance(value, float):
            value = max(-1.0, min(1.0, value))
            buf.append(int(value * 32767.0))
        else:
            buf.append(int(value))
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(buf.tobytes())
    # silence safety if empty
    data = out.getvalue()
    if len(data) <= 44:
        silent = io.BytesIO()
        with wave.open(silent, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate or 24000)
            wav.writeframes(b"\x00\x00" * max(1, sample_rate // 10))
        return silent.getvalue()
    return data


def _start_keepalive() -> None:
    """AMD GPUs downclock when idle; a tiny periodic matmul keeps clocks up."""
    if not (_resolved_device or "").startswith("cuda") or os.environ.get("QWEN3_TTS_KEEPALIVE") == "0":
        return
    import torch

    def loop():
        a = torch.ones(256, 256, device=_resolved_device)
        while True:
            if not _busy.locked():
                (a @ a).sum().item()
            time.sleep(0.2)

    threading.Thread(target=loop, daemon=True).start()


def _clone_prompt(model):
    """Encode the reference clip once; re-encoding it per request costs seconds."""
    global _prompt_cache
    if _prompt_cache is None:
        _prompt_cache = model.create_voice_clone_prompt(ref_audio=REF_AUDIO, ref_text=REF_TEXT)
    return _prompt_cache


def synthesize(text: str, voice: str | None, language: str | None) -> bytes:
    model = _load_model()
    if model is None:
        raise RuntimeError(_load_error or "qwen-tts is not installed")
    language = language or DEFAULT_LANGUAGE
    if hasattr(model, "generate_voice_clone"):
        if not REF_AUDIO or not REF_TEXT:
            raise RuntimeError("Base model needs QWEN3_TTS_REF_AUDIO and QWEN3_TTS_REF_TEXT")
        with _busy:
            wavs, sr = model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=_clone_prompt(model),
            )
    elif hasattr(model, "generate_custom_voice"):
        wavs, sr = model.generate_custom_voice(
            text=text,
            language=language,
            speaker=voice or "Ryan",
        )
    else:
        raise RuntimeError("Unsupported qwen_tts model API")
    audio = wavs[0]
    return _pcm16_wav(audio, int(sr))


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    data = json.loads(raw.decode("utf-8") or "{}")
    if not isinstance(data, dict):
        raise ValueError("JSON object required")
    return data


def _extract(body: dict[str, Any]) -> tuple[str, str | None, str | None]:
    text = str(body.get("input") or body.get("text") or "").strip()
    voice = body.get("voice") or body.get("speaker")
    voice = str(voice).strip() if isinstance(voice, str) and voice.strip() else None
    language = body.get("language")
    language = str(language).strip() if isinstance(language, str) and language.strip() else None
    return text, voice, language


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # quieter default
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict[str, Any]) -> None:
        self._send(code, (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/v1/health", "/health"):
            ready = _load_model() is not None
            self._json(200 if ready else 503, {
                "ok": ready,
                "model": MODEL_ID,
                "device": _resolved_device or DEVICE or "auto",
                "error": _load_error,
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path not in ("/tts", "/v1/tts", "/v1/audio/speech"):
            self._json(404, {"error": "not found"})
            return
        try:
            body = _read_json(self)
            text, voice, language = _extract(body)
            if not text:
                self._json(400, {"error": "text/input is required"})
                return
            wav = synthesize(text, voice, language)
            self._send(200, wav, "audio/wav")
        except Exception as exc:
            traceback.print_exc()
            code = 501 if "not installed" in str(exc) or "needs QWEN3_TTS_REF" in str(exc) else 500
            self._json(code, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"leafcode-tts server on http://127.0.0.1:{PORT} model={MODEL_ID} device={DEVICE or 'auto'}", flush=True)
    _load_model()
    if _resolved_device:
        print(f"using device {_resolved_device}", flush=True)
    if _load_error:
        print(f"qwen-tts unavailable ({_load_error}); synthesis returns 501 until installed", flush=True)
    else:
        _start_keepalive()
        try:
            start = time.time()
            synthesize("ウォームアップ", None, None)
            print(f"warmup done in {time.time() - start:.1f}s", flush=True)
        except Exception as exc:
            print(f"warmup failed: {exc}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

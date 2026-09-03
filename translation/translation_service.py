#!/usr/bin/env python3
"""Small JSON-lines wrapper around Argos Translate.

The process is intentionally stdio-only.  LeafCode host owns its lifetime and
the model directory; no network listener is created here.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path


def write_response(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packages-dir", required=True)
    args = parser.parse_args()

    packages_dir = Path(args.packages_dir).resolve()
    packages_dir.mkdir(parents=True, exist_ok=True)
    os.environ["ARGOS_PACKAGES_DIR"] = str(packages_dir)
    os.environ.setdefault("ARGOS_DEVICE_TYPE", "cpu")
    os.environ.setdefault("ARGOS_COMPUTE_TYPE", "int8")
    os.environ.setdefault("ARGOS_INTER_THREADS", "1")
    os.environ.setdefault("ARGOS_CHUNK_TYPE", "MINISBD")

    try:
        from argostranslate import translate
    except Exception as exc:  # pragma: no cover - environment dependent
        print(f"translation import failed: {exc}", file=sys.stderr, flush=True)
        return 2
    logging.getLogger("argostranslate").setLevel(logging.ERROR)
    logging.getLogger("argostranslate.utils").setLevel(logging.ERROR)

    # Signal the host only after Argos import succeeds so translate requests
    # do not race model/package loading.
    write_response({"v": 1, "type": "ready", "ok": True})

    cache: dict[tuple[str, str], object] = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if not isinstance(request_id, str):
                raise ValueError("id is required")
            if request.get("type") != "translate":
                raise ValueError("unsupported request type")
            source = request.get("source", "en")
            target = request.get("target", "ja")
            texts = request.get("texts")
            if source != "en" or target != "ja":
                raise ValueError("only en -> ja is supported")
            if not isinstance(texts, list) or not texts or len(texts) > 16:
                raise ValueError("texts must contain 1-16 items")
            if any(not isinstance(text, str) or not text.strip() for text in texts):
                raise ValueError("texts must contain non-empty strings")
            if sum(len(text) for text in texts) > 16_000:
                raise ValueError("translation request is too large")

            key = (source, target)
            translation = cache.get(key)
            if translation is None:
                translation = translate.get_translation_from_codes(source, target)
                if translation is None:
                    raise RuntimeError("en -> ja model is not installed")
                cache[key] = translation

            values = [translation.translate(text) for text in texts]
            write_response({"v": 1, "id": request_id, "ok": True, "translations": values})
        except Exception as exc:
            write_response({
                "v": 1,
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": str(exc)[:300],
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

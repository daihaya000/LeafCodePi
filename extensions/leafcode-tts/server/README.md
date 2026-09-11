# Qwen3-TTS HTTP front for leafcode-tts

stdlib だけの最小サーバー。`qwen-tts` が入っていれば WAV を返し、無ければ 501。

```powershell
cd extensions\leafcode-tts\server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:QWEN3_TTS_REF_AUDIO = "C:\path\to\ref.wav"
$env:QWEN3_TTS_REF_TEXT = "参照クリップの書き起こし"
$env:QWEN3_TTS_DEVICE = "cuda:0"   # ROCm/HIP でも多くのビルドは cuda:0
python server.py
```

LeafCode 側の `tts.json` / 設定画面:

```json
{
  "enabled": true,
  "url": "http://127.0.0.1:8080/v1/audio/speech",
  "voice": "ryan"
}
```

対応パス: `/tts`, `/v1/tts`, `/v1/audio/speech`, `/v1/health`.

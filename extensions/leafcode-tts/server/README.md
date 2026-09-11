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

## Windows ROCm (Radeon AI PRO R9700 / gfx1201)

`local.rocm.example.json` を `local.rocm.json` にコピーして参照音声・ポート等を書き、`start-rocm.ps1` を実行する。
スクリプトは ASCII のみで、日本語パスは JSON 側に置く（PS 5.1 の parse 事故回避）。ログは `%TEMP%\leafcode-tts-server.log`。

実測（R9700 / torch 2.12.0+rocm7.14.0 / HIP 7.14）:

- MIOpen の conv1d が bf16/fp16 で `miopenStatusUnknownError` になるため、既定 dtype は `float32`（`QWEN3_TTS_DTYPE` で変更可）
- 高速化済み: 参照音声の prompt キャッシュ、起動時ウォームアップ、GPU keepalive スレッド
- keepalive の効果は大きい：20 秒アイドル後の 1 文が ON で 16.5 秒、OFF だと 73.5 秒（AMD のアイドルダウンクロック）。`QWEN3_TTS_KEEPALIVE=0` で無効化
- 定常速度は RTF 約 8（1.6 秒の音声に約 15 秒）。リアルタイム読み上げには遅く、既定の SAPI バックエンドの方が実用的
- bf16 は MIOpen の conv を fp32 に逃しても fp32 直接より遅かった（RTF 9 前後）。CPU は RTF 40 で論外

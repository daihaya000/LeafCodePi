import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  TTS_BACKENDS,
  backendLabel,
  detectTtsBackend,
  getTtsBackend,
  normalizeTtsUrl,
  parseAivisSpeakers,
  voiceLabel,
} from "./tts-backends";

describe("tts-backends", () => {
  it("detects known backends from the synthesis URL", () => {
    assert.equal(detectTtsBackend(""), "sapi");
    assert.equal(detectTtsBackend("http://127.0.0.1:10101"), "aivis");
    assert.equal(detectTtsBackend("http://127.0.0.1:10101/"), "aivis");
    assert.equal(detectTtsBackend("http://127.0.0.1:18080/v1/audio/speech"), "qwen");
    assert.equal(detectTtsBackend("http://127.0.0.1:9999/tts"), "custom");
  });

  it("exposes preset defaults for each bundled backend", () => {
    assert.equal(TTS_BACKENDS.length, 3);
    assert.equal(getTtsBackend("aivis")?.defaultVoice, "871574624");
    assert.equal(voiceLabel("aivis", "871574624"), "ramuchi / ノーマル");
    assert.equal(voiceLabel("aivis", "1257529344"), "kanna / ノーマル");
    assert.equal(getTtsBackend("qwen")?.url.includes("/v1/audio/speech"), true);
    assert.equal(backendLabel("sapi"), "Windows SAPI");
    assert.equal(backendLabel("custom"), "カスタム URL");
    assert.equal(voiceLabel("aivis", "888753760"), "まお / ノーマル");
    assert.equal(normalizeTtsUrl("http://x/"), "http://x");
  });

  it("parses installed AivisSpeech talk styles and ignores duplicate or singing styles", () => {
    assert.deepEqual(
      parseAivisSpeakers([
        {
          name: "追加モデル",
          styles: [
            { id: 1, name: "ノーマル", type: "talk" },
            { id: 2, name: "歌", type: "sing" },
          ],
        },
        { name: "別モデル", styles: [{ id: 1, name: "重複", type: "talk" }, { id: "3", name: "静か" }] },
      ]),
      [
        { id: "1", label: "追加モデル / ノーマル" },
        { id: "3", label: "別モデル / 静か" },
      ],
    );
  });
});

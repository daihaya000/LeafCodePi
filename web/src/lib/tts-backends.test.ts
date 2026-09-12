import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  TTS_BACKENDS,
  backendLabel,
  detectTtsBackend,
  getTtsBackend,
  normalizeTtsUrl,
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
    assert.equal(getTtsBackend("aivis")?.defaultVoice, "1455757728");
    assert.equal(voiceLabel("aivis", "1455757728"), "ramuchi / ノーマル");
    assert.equal(getTtsBackend("qwen")?.url.includes("/v1/audio/speech"), true);
    assert.equal(backendLabel("sapi"), "Windows SAPI");
    assert.equal(backendLabel("custom"), "カスタム URL");
    assert.equal(voiceLabel("aivis", "888753760"), "まお / ノーマル");
    assert.equal(normalizeTtsUrl("http://x/"), "http://x");
  });
});

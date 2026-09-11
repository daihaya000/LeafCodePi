import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { TTS_CONFIG_FILE, readTtsConfig, writeTtsConfig } from "./tts-config";

describe("tts-config", () => {
  let previousDataDir: string | undefined;
  let data: string;

  beforeEach(() => {
    previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    data = mkdtempSync(join(tmpdir(), "leafcode-tts-cfg-"));
    process.env.LEAFCODE_PI_DATA_DIR = data;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(data, { recursive: true, force: true });
  });

  it("defaults to disabled when no config exists", () => {
    assert.deepEqual(readTtsConfig(), { enabled: false, voice: "", rate: 0, url: "" });
  });

  it("persists enabled/voice/rate/url and drops empty optional fields", () => {
    assert.deepEqual(
      writeTtsConfig({
        enabled: true,
        voice: "Microsoft Haruka Desktop",
        rate: 2,
        url: "http://127.0.0.1:8080/tts",
      }),
      {
        enabled: true,
        voice: "Microsoft Haruka Desktop",
        rate: 2,
        url: "http://127.0.0.1:8080/tts",
      },
    );
    const raw = JSON.parse(readFileSync(join(data, TTS_CONFIG_FILE), "utf8")) as Record<string, unknown>;
    assert.equal(raw.enabled, true);
    assert.equal(raw.voice, "Microsoft Haruka Desktop");
    assert.equal(raw.rate, 2);
    assert.equal(raw.url, "http://127.0.0.1:8080/tts");

    assert.deepEqual(writeTtsConfig({ enabled: false, voice: "  ", url: "" }), {
      enabled: false,
      voice: "",
      rate: 2,
      url: "",
    });
    const cleared = JSON.parse(readFileSync(join(data, TTS_CONFIG_FILE), "utf8")) as Record<string, unknown>;
    assert.equal(cleared.enabled, false);
    assert.equal("voice" in cleared, false);
    assert.equal("url" in cleared, false);
  });

  it("clamps rate and writes into a missing nested data dir", () => {
    process.env.LEAFCODE_PI_DATA_DIR = join(data, "nested", "missing");
    assert.equal(writeTtsConfig({ rate: 99 }).rate, 10);
    assert.equal(readTtsConfig().rate, 10);
    const leftovers = readdirSync(join(data, "nested", "missing")).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("ignores corrupt json", () => {
    writeFileSync(join(data, TTS_CONFIG_FILE), "{not-json", "utf8");
    assert.deepEqual(readTtsConfig(), { enabled: false, voice: "", rate: 0, url: "" });
  });
});

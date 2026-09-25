import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  flushModelThroughput,
  modelThroughputKey,
  readModelThroughputAverages,
  recordModelThroughput,
} from "./model-throughput-stats";

let dir: string;
const previous = process.env.LEAFCODE_PI_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "leafcode-throughput-"));
  process.env.LEAFCODE_PI_DATA_DIR = dir;
});

afterEach(async () => {
  await flushModelThroughput();
  if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "model-throughput.json");

describe("model throughput stats", () => {
  it("token-weights decode samples and skips short or invalid samples", async () => {
    // 101 tok / 1s → 100 tok/s、301 tok / 10s → 30 tok/s。加重平均 400 / 11s。
    recordModelThroughput("openai", "gpt", { outputTokens: 101, decodeMs: 1_000 });
    recordModelThroughput("openai", "gpt", { outputTokens: 301, decodeMs: 10_000 });
    recordModelThroughput("openai", "gpt", { outputTokens: 5, decodeMs: 1_000 });
    recordModelThroughput("openai", "gpt", { outputTokens: 100, decodeMs: 0 });
    const averages = await readModelThroughputAverages();
    expect(averages.get(modelThroughputKey("openai", "gpt"))).toBeCloseTo(400 / 11);
  });

  it("merges pending deltas into the file written by another process", async () => {
    writeFileSync(file(), JSON.stringify({ "openai::gpt": { tokens: 100, ms: 1_000 } }), "utf8");
    recordModelThroughput("openai", "gpt", { outputTokens: 101, decodeMs: 1_000 });
    await flushModelThroughput();
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ "openai::gpt": { tokens: 200, ms: 2_000 } });
    expect(existsSync(`${file()}.lock`)).toBe(false);
  });

  it("recovers from corrupt, array-shaped, or legacy stats files", async () => {
    writeFileSync(file(), "[]", "utf8");
    recordModelThroughput("openai", "gpt", { outputTokens: 31, decodeMs: 1_000 });
    await flushModelThroughput();
    expect((await readModelThroughputAverages()).get(modelThroughputKey("openai", "gpt"))).toBe(30);
    writeFileSync(file(), JSON.stringify({ "openai::gpt": { sum: 40, count: 1 } }), "utf8");
    expect((await readModelThroughputAverages()).size).toBe(0);
    writeFileSync(file(), "{broken", "utf8");
    expect((await readModelThroughputAverages()).size).toBe(0);
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    const lock = `${file()}.lock`;
    writeFileSync(lock, "", "utf8");
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    recordModelThroughput("openai", "gpt", { outputTokens: 51, decodeMs: 1_000 });
    await flushModelThroughput();
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ "openai::gpt": { tokens: 50, ms: 1_000 } });
  });
});

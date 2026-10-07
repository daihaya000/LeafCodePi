import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushModelThroughput, modelThroughputKey, readModelThroughputAverages, recordModelThroughput } from "./model-throughput-stats";
import { setSetting } from "./pi/web-settings";
import { MODEL_THROUGHPUT_WINDOW_SETTING_KEY } from "./model-throughput-settings";

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
const key = modelThroughputKey("openai", "gpt");
const sample = (id: string, at: number, tokens = 100, ms = 1000) => ({ id, at, tokens, ms });
const store = (models: Record<string, unknown>) => writeFileSync(file(), JSON.stringify({ version: 2, models }), "utf8");
const record = (tokens = 100, ms = 1000) => recordModelThroughput("openai", "gpt", { outputTokens: tokens + 1, decodeMs: ms });

describe("model throughput stats", () => {
  it("weights decode samples by time and skips short or invalid samples", async () => {
    record(100);
    record(300, 10_000);
    record(4);
    record(100, 0);
    record(NaN);
    record(100, Infinity);
    recordModelThroughput("", "gpt", { outputTokens: 100, decodeMs: 1000 });
    expect((await readModelThroughputAverages()).get(key)).toBeCloseTo(400 / 11);
  });

  it("uses only the latest 50 valid responses by default", async () => {
    record(1000);
    for (let i = 0; i < 50; i++) record(20);
    record(4);
    expect((await readModelThroughputAverages()).get(key)).toBe(20);
    await flushModelThroughput();
    expect((await readModelThroughputAverages()).get(key)).toBe(20);
  });

  it("applies window changes without restart and retains samples when shrinking", async () => {
    record(100);
    await flushModelThroughput();
    record(20);
    setSetting(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, "1");
    expect((await readModelThroughputAverages()).get(key)).toBe(20);
    await flushModelThroughput();
    setSetting(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, "50");
    expect((await readModelThroughputAverages()).get(key)).toBe(60);
  });

  it("keeps models and providers independent and uses available samples below N", async () => {
    record(100);
    recordModelThroughput("openai", "other", { outputTokens: 31, decodeMs: 1000 });
    recordModelThroughput("anthropic", "gpt", { outputTokens: 51, decodeMs: 1000 });
    const averages = await readModelThroughputAverages();
    expect(averages.get(key)).toBe(100);
    expect(averages.get("openai::other")).toBe(30);
    expect(averages.get("anthropic::gpt")).toBe(50);
  });

  it("merges another process's samples ordered by completion time", async () => {
    record(20);
    const older = sample("external", 1);
    store({ [key]: [older] });
    await flushModelThroughput();
    const saved = JSON.parse(readFileSync(file(), "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.models[key]).toHaveLength(2);
    expect(saved.models[key][0]).toEqual(older);
    setSetting(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, "1");
    expect((await readModelThroughputAverages()).get(key)).toBe(20);
    expect(existsSync(`${file()}.lock`)).toBe(false);
  });

  it("selects the newest responses even if another process wrote them out of order", async () => {
    store({ [key]: [sample("newest", 3, 30), sample("oldest", 1, 100), sample("middle", 2, 20)] });
    setSetting(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, "2");
    expect((await readModelThroughputAverages()).get(key)).toBe(25);
  });

  it("caps retained history at 1000 samples even before flushing", async () => {
    for (let i = 0; i < 1001; i++) record(i + 20);
    setSetting(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, "1000");
    expect((await readModelThroughputAverages()).get(key)).toBe(520.5);
    await flushModelThroughput();
    expect(JSON.parse(readFileSync(file(), "utf8")).models[key]).toHaveLength(1000);
    expect((await readModelThroughputAverages()).get(key)).toBe(520.5);
  });

  it("does not lose or double-count samples while a flush is active", async () => {
    record(100);
    const flushing = flushModelThroughput();
    record(20);
    expect((await readModelThroughputAverages()).get(key)).toBe(60);
    await flushing;
    expect((await readModelThroughputAverages()).get(key)).toBe(60);
    await flushModelThroughput();
    expect(JSON.parse(readFileSync(file(), "utf8")).models[key]).toHaveLength(2);
  });

  it("discards cumulative legacy data rather than treating it as one response", async () => {
    writeFileSync(file(), JSON.stringify({ [key]: { tokens: 100000, ms: 1000 } }), "utf8");
    expect((await readModelThroughputAverages()).size).toBe(0);
    record(20);
    expect((await readModelThroughputAverages()).get(key)).toBe(20);
    await flushModelThroughput();
    expect(JSON.parse(readFileSync(file(), "utf8")).models[key]).toHaveLength(1);
  });

  it("recovers from corruption and filters malformed or duplicate samples", async () => {
    for (const raw of ["[]", "{broken", '{"version":2,"models":[]}']) {
      writeFileSync(file(), raw, "utf8");
      expect((await readModelThroughputAverages()).size).toBe(0);
    }
    store({ [key]: [sample("ok", 1, 20), sample("ok", 1, 20), null, { tokens: 100, ms: 1 }, sample("short", 2, 1), sample("zero", 2, 100, 0)], bad: {} });
    expect((await readModelThroughputAverages()).get(key)).toBe(20);
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    const lock = `${file()}.lock`;
    writeFileSync(lock, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    record(50);
    await flushModelThroughput();
    expect((await readModelThroughputAverages()).get(key)).toBe(50);
    expect(existsSync(lock)).toBe(false);
  });

  it("preserves pending samples on lock timeout and retries without duplication", async () => {
    const lock = `${file()}.lock`;
    writeFileSync(lock, "", "utf8");
    record(100);
    await flushModelThroughput();
    expect((await readModelThroughputAverages()).get(key)).toBe(100);
    rmSync(lock);
    record(20);
    await flushModelThroughput();
    expect((await readModelThroughputAverages()).get(key)).toBe(60);
    expect(JSON.parse(readFileSync(file(), "utf8")).models[key]).toHaveLength(2);
  });
});

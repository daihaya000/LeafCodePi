import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

afterEach(() => {
  if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("model throughput stats", () => {
  it("averages recorded rates per provider/model and ignores invalid rates", () => {
    recordModelThroughput("openai", "gpt", 40);
    recordModelThroughput("openai", "gpt", 60);
    recordModelThroughput("openai", "gpt", 0);
    recordModelThroughput("openai", "gpt", Number.NaN);
    recordModelThroughput("anthropic", "claude", 100);
    const averages = readModelThroughputAverages();
    expect(averages.get(modelThroughputKey("openai", "gpt"))).toBe(50);
    expect(averages.get(modelThroughputKey("anthropic", "claude"))).toBe(100);
  });

  it("recovers from a corrupt or array-shaped stats file", () => {
    writeFileSync(join(dir, "model-throughput.json"), "[]", "utf8");
    recordModelThroughput("openai", "gpt", 30);
    expect(readModelThroughputAverages().get(modelThroughputKey("openai", "gpt"))).toBe(30);
    writeFileSync(join(dir, "model-throughput.json"), "{broken", "utf8");
    expect(readModelThroughputAverages().size).toBe(0);
  });
});

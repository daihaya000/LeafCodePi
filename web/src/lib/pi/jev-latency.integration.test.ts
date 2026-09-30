import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));

// 実web-settingsを通しつつ、実データディレクトリには触らない。
vi.mock("@/lib/paths", () => ({ dataDir: () => state.dir }));

import { JEV_LATENCY_SETTING_KEY, readJevLatencyStats, recordJevLatency } from "./jev-latency";

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), "jev-latency-"));
});

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

describe("Jev latency store against the real settings file", () => {
  it("persists rounded samples in web-settings.json and reads them back", () => {
    recordJevLatency("jev-1.13", 100.4);
    recordJevLatency("jev-1.13", 149.6);
    expect(readJevLatencyStats()).toEqual({ "jev-1.13": { count: 2, averageMs: 125, lastMs: 150 } });
    const file = JSON.parse(readFileSync(join(state.dir, "web-settings.json"), "utf8"));
    expect(String(file[JEV_LATENCY_SETTING_KEY])).toContain("jev-1.13");
  });

  it("recovers from a corrupt settings file without losing later samples", () => {
    writeFileSync(join(state.dir, "web-settings.json"), "{broken", "utf8");
    expect(readJevLatencyStats()).toEqual({});
    recordJevLatency("jev-1.13", 42);
    expect(readJevLatencyStats()).toEqual({ "jev-1.13": { count: 1, averageMs: 42, lastMs: 42 } });
  });
});

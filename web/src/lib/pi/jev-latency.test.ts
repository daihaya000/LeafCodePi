import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ settings: { version: 1 } as Record<string, unknown> }));

vi.mock("./web-settings", () => ({
  getSetting: (key: string) => {
    const value = store.settings[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  },
  updateSettingsFile: vi.fn((update: (settings: Record<string, unknown>) => unknown) => update(store.settings)),
}));

import { JEV_LATENCY_MAX_MODELS, JEV_LATENCY_SETTING_KEY, readJevLatencyStats, recordJevLatency } from "./jev-latency";
import { updateSettingsFile } from "./web-settings";

beforeEach(() => {
  store.settings = { version: 1 };
  vi.useRealTimers();
  vi.mocked(updateSettingsFile).mockClear();
});

describe("Jev latency store", () => {
  it("records per-model samples and returns rounded averages", () => {
    recordJevLatency("jev-1.13", 100.4);
    recordJevLatency("jev-1.13", 199.6);
    recordJevLatency("other", 50);
    expect(readJevLatencyStats()).toEqual({
      "jev-1.13": { count: 2, averageMs: 150, lastMs: 200 },
      other: { count: 1, averageMs: 50, lastMs: 50 },
    });
  });

  it("ignores invalid samples and model ids", () => {
    for (const sample of [Number.NaN, -1, Number.POSITIVE_INFINITY, 10 * 60 * 1000 + 1]) {
      recordJevLatency("ok", sample);
    }
    for (const model of ["", "bad id", "bad\u0007", "x".repeat(257)]) {
      recordJevLatency(model, 10);
    }
    expect(readJevLatencyStats()).toEqual({});
    expect(store.settings[JEV_LATENCY_SETTING_KEY]).toBeUndefined();
  });

  it("starts from an empty map when the stored value is corrupt", () => {
    store.settings[JEV_LATENCY_SETTING_KEY] = "{not json";
    expect(readJevLatencyStats()).toEqual({});
    recordJevLatency("jev", 10);
    expect(readJevLatencyStats()).toEqual({ jev: { count: 1, averageMs: 10, lastMs: 10 } });
  });

  it("drops corrupt entries but keeps valid ones", () => {
    store.settings[JEV_LATENCY_SETTING_KEY] = JSON.stringify({
      version: 1,
      models: {
        good: { count: 2, totalMs: 30, lastMs: 20, updatedAt: 1 },
        negative: { count: -1, totalMs: 0, lastMs: 0, updatedAt: 1 },
        zero: { count: 0, totalMs: 0, lastMs: 0, updatedAt: 1 },
        fractional: { count: 1.5, totalMs: 10, lastMs: 10, updatedAt: 1 },
        missingUpdatedAt: { count: 1, totalMs: 10, lastMs: 10 },
        notAnObject: "x",
      },
    });
    expect(readJevLatencyStats()).toEqual({ good: { count: 2, averageMs: 15, lastMs: 20 } });
  });

  it("evicts the oldest models beyond the cap", () => {
    vi.useFakeTimers();
    for (let index = 0; index <= JEV_LATENCY_MAX_MODELS; index++) {
      vi.setSystemTime(1_000_000 + index);
      recordJevLatency(`model-${index}`, 10);
    }
    const stats = readJevLatencyStats();
    expect(Object.keys(stats)).toHaveLength(JEV_LATENCY_MAX_MODELS);
    expect(stats["model-0"]).toBeUndefined();
    expect(stats[`model-${JEV_LATENCY_MAX_MODELS}`]).toEqual({ count: 1, averageMs: 10, lastMs: 10 });
  });

  it("never throws when the settings store fails", () => {
    vi.mocked(updateSettingsFile).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => recordJevLatency("ok", 10)).not.toThrow();
    expect(readJevLatencyStats()).toEqual({});
  });
});

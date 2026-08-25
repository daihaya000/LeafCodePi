import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  nextHealthCache,
  nextModelCache,
  readHealthCache,
  readModelCache,
} from "./harness";
import type { HealthDto } from "@/lib/types";

const healthy: HealthDto = {
  ok: true,
  engine: "pi",
  engineOk: true,
  version: "1.2.3",
  modelCount: 7,
  dataDir: "C:/data",
  error: null,
};

const broken: HealthDto = { ...healthy, ok: false, engineOk: false, modelCount: 0, error: "boom" };

describe("readHealthCache", () => {
  it("returns null without an entry", () => {
    assert.equal(readHealthCache(null, 1_000), null);
  });

  it("returns the value while the entry is younger than the TTL", () => {
    const entry = { at: 1_000, value: healthy };
    assert.equal(readHealthCache(entry, 1_000, 15_000), healthy);
    assert.equal(readHealthCache(entry, 15_999, 15_000), healthy);
  });

  it("expires exactly at the TTL boundary", () => {
    const entry = { at: 1_000, value: healthy };
    assert.equal(readHealthCache(entry, 16_000, 15_000), null);
  });

  it("ignores an entry stamped in the future (clock moved backwards)", () => {
    assert.equal(readHealthCache({ at: 5_000, value: healthy }, 1_000, 15_000), null);
  });
});

describe("nextHealthCache", () => {
  it("stores a healthy snapshot", () => {
    assert.deepEqual(nextHealthCache(healthy, 42), { at: 42, value: healthy });
  });

  it("refuses to cache a broken engine so recovery polling stays live", () => {
    assert.equal(nextHealthCache(broken, 42), null);
  });
});

describe("model cache", () => {
  const models = [{
    value: "test::model",
    label: "Test",
    providerID: "test",
    modelID: "model",
  }];

  it("serves a fresh model snapshot", () => {
    const entry = nextModelCache(models, 1_000);
    assert.equal(readModelCache(entry, 15_999, 15_000), models);
    assert.equal(readModelCache(entry, 16_000, 15_000), null);
  });

  it("does not cache an empty model list", () => {
    assert.equal(nextModelCache([], 1_000), null);
  });
});

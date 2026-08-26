import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { getRuntimeFor } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
});

describe("getRuntimeFor", () => {
  it("returns the default singleton regardless of accountId in Phase 2", () => {
    const stub = { id: "default-runtime" };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: stub,
      live: new Map(),
      lastProviderSyncWarnings: [],
    };
    assert.equal(getRuntimeFor(), stub);
    assert.equal(getRuntimeFor(undefined), stub);
    assert.equal(getRuntimeFor(null), stub);
    // Phase 6 でアカウント別ランタイムへ多重化されるまで、accountId は無視される
    assert.equal(getRuntimeFor("acc-1"), stub);
  });

  it("returns null before the runtime is initialized", () => {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
    };
    assert.equal(getRuntimeFor(), null);
    assert.equal(getRuntimeFor("acc-1"), null);
  });
});

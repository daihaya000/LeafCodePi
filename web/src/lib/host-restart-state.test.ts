import { describe, expect, it } from "vitest";
import { createBackendRestartCheck } from "./host-restart-state";

describe("Backend restart completion", () => {
  it("does not accept the old ready process after a refused stop", () => {
    const old = { backend: { ready: true, startedAt: "old" } };
    const complete = createBackendRestartCheck(old);
    expect(complete(old)).toBe(false);
    expect(complete({ backend: { ready: false } })).toBe(false);
    expect(complete(old)).toBe(false);
    expect(complete({ backend: { ready: true, startedAt: "new" } })).toBe(true);
  });

  it("accepts a fast restart with an identical bundle only after process replacement", () => {
    const complete = createBackendRestartCheck({ backend: { ready: true, startedAt: "old", generation: { matches: true } } });
    expect(complete({ backend: { ready: true, startedAt: "new", generation: { matches: true } } })).toBe(true);
    expect(complete({ backend: { ready: true, startedAt: "new", generation: { matches: false } } })).toBe(false);
  });

  it("requires an observed outage when the previous process cannot be identified", () => {
    const complete = createBackendRestartCheck(null);
    expect(complete({ backend: { ready: true, startedAt: "unknown" } })).toBe(false);
    expect(complete({ backend: { ready: false } })).toBe(false);
    expect(complete({ backend: { ready: true, startedAt: "new" } })).toBe(true);
    expect(complete({ backend: { ready: true } })).toBe(false);
  });
});

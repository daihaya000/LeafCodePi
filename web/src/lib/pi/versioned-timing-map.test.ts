import { describe, expect, it } from "vitest";
import { VersionedTimingMap } from "./versioned-timing-map";

describe("VersionedTimingMap", () => {
  it("tracks overwrites and removals without changing the restored baseline", () => {
    const timing = new VersionedTimingMap([["call-1", 1_000]]);
    expect(timing.revision).toBe(0);
    expect(timing.get("call-1")).toBe(1_000);

    timing.set("call-1", 2_000);
    expect(timing.size).toBe(1);
    expect(timing.revision).toBe(1);
    timing.set("call-2", 3_000);
    expect(timing.revision).toBe(2);
    expect(timing.delete("missing")).toBe(false);
    expect(timing.revision).toBe(2);
    expect(timing.delete("call-1")).toBe(true);
    expect(timing.revision).toBe(3);
    timing.clear();
    expect(timing.revision).toBe(4);
    timing.clear();
    expect(timing.revision).toBe(4);
  });
});

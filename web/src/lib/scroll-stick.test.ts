import { describe, expect, it } from "vitest";
import { clampScrollTop, isNearBottom, maxScrollTop, nextStickState } from "./scroll-stick";

describe("scroll bounds", () => {
  it("computes the legal maximum scrollTop", () => {
    expect(maxScrollTop(100, 1000)).toBe(900);
    expect(maxScrollTop(100, 80)).toBe(0);
  });

  it("clamps programmatic targets to the scroll range", () => {
    expect(clampScrollTop(1200, 100, 1000)).toBe(900);
    expect(clampScrollTop(-20, 100, 1000)).toBe(0);
  });
});

describe("isNearBottom", () => {
  it("treats the last 80px as near bottom", () => {
    // max scrollTop = 900; near-bottom when scrollTop >= 820
    expect(isNearBottom(820, 100, 1000)).toBe(true);
    expect(isNearBottom(819, 100, 1000)).toBe(false);
  });

  it("accepts a custom threshold", () => {
    expect(isNearBottom(970, 100, 1000, 24)).toBe(true);
    expect(isNearBottom(875, 100, 1000, 24)).toBe(false);
  });
});

describe("nextStickState", () => {
  it("re-sticks when at bottom", () => {
    expect(nextStickState(false, 900, 800, true)).toBe(true);
  });

  it("unsticks only on clear upward scroll", () => {
    expect(nextStickState(true, 500, 520, false)).toBe(false);
    expect(nextStickState(true, 500, 503, false)).toBe(true);
  });

  it("keeps stick when content grows and scrollTop stays put", () => {
    // Bottom moved away; user did not scroll up.
    expect(nextStickState(true, 400, 400, false)).toBe(true);
  });

  it("keeps unstuck when still scrolled up", () => {
    expect(nextStickState(false, 200, 200, false)).toBe(false);
  });
});

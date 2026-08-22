import { describe, expect, it } from "vitest";
import {
  clampScrollButtonOpacity,
  DEFAULT_SCROLL_BUTTON_OPACITY,
  MAX_SCROLL_BUTTON_OPACITY,
  MIN_SCROLL_BUTTON_OPACITY,
} from "./scroll-button-opacity";

describe("clampScrollButtonOpacity", () => {
  it("keeps in-range values and clamps the edges", () => {
    expect(clampScrollButtonOpacity(0.6)).toBe(0.6);
    expect(clampScrollButtonOpacity(MIN_SCROLL_BUTTON_OPACITY)).toBe(MIN_SCROLL_BUTTON_OPACITY);
    expect(clampScrollButtonOpacity(MAX_SCROLL_BUTTON_OPACITY)).toBe(MAX_SCROLL_BUTTON_OPACITY);
    expect(clampScrollButtonOpacity(0.05)).toBe(MIN_SCROLL_BUTTON_OPACITY);
    expect(clampScrollButtonOpacity(1.5)).toBe(MAX_SCROLL_BUTTON_OPACITY);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampScrollButtonOpacity(Number.NaN)).toBe(DEFAULT_SCROLL_BUTTON_OPACITY);
  });
});

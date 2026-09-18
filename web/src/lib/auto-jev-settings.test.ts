import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_JEV_MIN_CONFIDENCE,
  isAutoJevEnabled,
  isAutoJevMinConfidence,
  parseAutoJevMinConfidence,
} from "./auto-jev-settings";

describe("auto-jev-settings", () => {
  it("defaults to disabled and the conservative confidence threshold", () => {
    expect(isAutoJevEnabled(null)).toBe(false);
    expect(isAutoJevEnabled("0")).toBe(false);
    expect(isAutoJevEnabled("1")).toBe(true);
    expect(parseAutoJevMinConfidence(null)).toBe(DEFAULT_AUTO_JEV_MIN_CONFIDENCE);
  });

  it("accepts only configured confidence steps", () => {
    expect(isAutoJevMinConfidence(0.6)).toBe(true);
    expect(parseAutoJevMinConfidence("0.95")).toBe(0.95);
    expect(parseAutoJevMinConfidence("0.61")).toBe(DEFAULT_AUTO_JEV_MIN_CONFIDENCE);
    expect(parseAutoJevMinConfidence("0.5x")).toBe(DEFAULT_AUTO_JEV_MIN_CONFIDENCE);
  });
});

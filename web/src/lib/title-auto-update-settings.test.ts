import { describe, expect, it } from "vitest";
import {
  DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY,
  MAX_TITLE_AUTO_UPDATE_FREQUENCY,
  MIN_TITLE_AUTO_UPDATE_FREQUENCY,
  parseTitleAutoUpdateFrequency,
  shouldAutoUpdateTitle,
} from "./title-auto-update-settings";

describe("title auto-update frequency", () => {
  it("uses five turns by default and rejects values outside the range", () => {
    expect(DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY).toBe(5);
    expect(parseTitleAutoUpdateFrequency(null)).toBe(5);
    expect(parseTitleAutoUpdateFrequency("3")).toBe(3);
    expect(parseTitleAutoUpdateFrequency(String(MIN_TITLE_AUTO_UPDATE_FREQUENCY - 1))).toBe(5);
    expect(parseTitleAutoUpdateFrequency(String(MAX_TITLE_AUTO_UPDATE_FREQUENCY + 1))).toBe(5);
  });

  it("updates only on the configured turn boundary", () => {
    expect(shouldAutoUpdateTitle(4, 5)).toBe(false);
    expect(shouldAutoUpdateTitle(5, 5)).toBe(true);
    expect(shouldAutoUpdateTitle(10, 5)).toBe(true);
    expect(shouldAutoUpdateTitle(5, 0)).toBe(true);
  });
});

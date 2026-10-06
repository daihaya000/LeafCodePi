import { describe, expect, it } from "vitest";
import {
  clampHistoryPageSize,
  DEFAULT_HISTORY_PAGE_SIZE,
  HISTORY_PAGE_SIZE_SETTING_KEY,
  MAX_HISTORY_PAGE_SIZE,
  MIN_HISTORY_PAGE_SIZE,
  parseHistoryPageSize,
} from "./history-page-size";
import { validateSettingValue, ALLOWED_SETTING_KEYS } from "./pi/setting-validation";

describe("history page size", () => {
  it("clamps to the supported range and falls back to the default", () => {
    expect(clampHistoryPageSize(200)).toBe(200);
    expect(clampHistoryPageSize(1)).toBe(MIN_HISTORY_PAGE_SIZE);
    expect(clampHistoryPageSize(999_999)).toBe(MAX_HISTORY_PAGE_SIZE);
    expect(clampHistoryPageSize(120.6)).toBe(121);
    expect(clampHistoryPageSize(Number.NaN)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(clampHistoryPageSize("abc")).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(clampHistoryPageSize("")).toBe(DEFAULT_HISTORY_PAGE_SIZE);
  });

  it("parses a stored value, using the default when unset", () => {
    expect(parseHistoryPageSize(null)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(parseHistoryPageSize("300")).toBe(300);
    expect(parseHistoryPageSize("garbage")).toBe(DEFAULT_HISTORY_PAGE_SIZE);
  });

  it("is a writable setting that is validated and normalized", () => {
    expect(ALLOWED_SETTING_KEYS.has(HISTORY_PAGE_SIZE_SETTING_KEY)).toBe(true);
    expect(validateSettingValue(HISTORY_PAGE_SIZE_SETTING_KEY, "300")).toBe("300");
    expect(validateSettingValue(HISTORY_PAGE_SIZE_SETTING_KEY, "5")).toBe(String(MIN_HISTORY_PAGE_SIZE));
    expect(validateSettingValue(HISTORY_PAGE_SIZE_SETTING_KEY, "999999")).toBe(String(MAX_HISTORY_PAGE_SIZE));
    expect(validateSettingValue(HISTORY_PAGE_SIZE_SETTING_KEY, "abc")).toBeNull();
    expect(validateSettingValue(HISTORY_PAGE_SIZE_SETTING_KEY, "")).toBeNull();
  });
});

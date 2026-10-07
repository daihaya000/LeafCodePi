import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_THROUGHPUT_WINDOW, MODEL_THROUGHPUT_WINDOW_SETTING_KEY, parseModelThroughputWindow } from "./model-throughput-settings";
import { ALLOWED_SETTING_KEYS, validateSettingValue } from "./pi/setting-validation";

describe("model throughput window setting", () => {
  it("defaults to 50 and accepts integer windows from 1 to 1000", () => {
    expect(DEFAULT_MODEL_THROUGHPUT_WINDOW).toBe(50);
    for (const value of [null, "", "invalid", "0", "-1", "2.5", "1001", "Infinity"]) {
      expect(parseModelThroughputWindow(value)).toBe(50);
    }
    for (const value of ["1", "75", "1000"]) expect(parseModelThroughputWindow(value)).toBe(Number(value));
  });

  it("allows the setting API and transfer validation, rejecting invalid values", () => {
    expect(ALLOWED_SETTING_KEYS.has(MODEL_THROUGHPUT_WINDOW_SETTING_KEY)).toBe(true);
    for (const value of ["1", "75", "1000"]) {
      expect(validateSettingValue(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, value)).toBe(value);
    }
    for (const value of ["", "invalid", "0", "-1", "2.5", "1001", "Infinity"]) {
      expect(validateSettingValue(MODEL_THROUGHPUT_WINDOW_SETTING_KEY, value)).toBeNull();
    }
  });
});

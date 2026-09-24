import { describe, expect, it } from "vitest";
import {
  CODEXBAR_WIDGET_SETTING_KEY,
  SYSMON_WIDGET_SETTING_KEY,
  validateWidgetSettingValue,
} from "./widget-settings";

describe("validateWidgetSettingValue", () => {
  it("normalizes CodexBar settings and drops unknown fields", () => {
    expect(
      validateWidgetSettingValue(
        CODEXBAR_WIDGET_SETTING_KEY,
        JSON.stringify({ collapsed: false, twoColumn: "x", providerCollapsed: { a: true, b: false }, extra: 1 }),
      ),
    ).toBe(JSON.stringify({ collapsed: false, providerCollapsed: { a: true } }));
  });

  it("normalizes Sysmon hidden items", () => {
    expect(
      validateWidgetSettingValue(
        SYSMON_WIDGET_SETTING_KEY,
        JSON.stringify({ twoColumn: true, hidden: ["cpu", "cpu", 1, ""] }),
      ),
    ).toBe(JSON.stringify({ twoColumn: true, hidden: ["cpu"] }));
  });

  it("rejects invalid JSON, non-objects and unknown keys", () => {
    expect(validateWidgetSettingValue(SYSMON_WIDGET_SETTING_KEY, "{")).toBeNull();
    expect(validateWidgetSettingValue(SYSMON_WIDGET_SETTING_KEY, "[]")).toBeNull();
    expect(validateWidgetSettingValue("other", "{}")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyOpenAiFastMode,
  isOpenAiFastModeEnabled,
  supportsOpenAiFastMode,
} from "./openai-fast-mode";
import { ALLOWED_SETTING_KEYS, validateSettingValue } from "./pi/setting-validation";

describe("openai fast mode", () => {
  it("parses the stored setting", () => {
    expect(isOpenAiFastModeEnabled("1")).toBe(true);
    expect(isOpenAiFastModeEnabled("0")).toBe(false);
    expect(isOpenAiFastModeEnabled(null)).toBe(false);
  });

  it("targets only OpenAI providers", () => {
    expect(supportsOpenAiFastMode("openai")).toBe(true);
    expect(supportsOpenAiFastMode("openai-codex")).toBe(true);
    expect(supportsOpenAiFastMode("anthropic")).toBe(false);
    expect(supportsOpenAiFastMode(undefined)).toBe(false);
  });

  it("adds service_tier without mutating the payload", () => {
    const payload = { model: "gpt-5" };
    expect(applyOpenAiFastMode(payload, "openai", true)).toEqual({ model: "gpt-5", service_tier: "priority" });
    expect(payload).toEqual({ model: "gpt-5" });
  });

  it("leaves payloads alone when disabled, unsupported, malformed or already tiered", () => {
    expect(applyOpenAiFastMode({ model: "m" }, "openai", false)).toBeUndefined();
    expect(applyOpenAiFastMode({ model: "m" }, "google", true)).toBeUndefined();
    expect(applyOpenAiFastMode(null, "openai", true)).toBeUndefined();
    expect(applyOpenAiFastMode([], "openai", true)).toBeUndefined();
    expect(applyOpenAiFastMode({ service_tier: "flex" }, "openai", true)).toBeUndefined();
  });

  it("is an allowed setting that accepts only 1", () => {
    expect(ALLOWED_SETTING_KEYS.has("openai-fast-mode")).toBe(true);
    expect(validateSettingValue("openai-fast-mode", "1")).toBe("1");
    expect(validateSettingValue("openai-fast-mode", "yes")).toBeNull();
  });
});

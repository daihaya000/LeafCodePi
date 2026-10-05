import { describe, expect, it } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS, enabledJevModelKeys, hasUsableJevModel, normalizeJevModelSettings } from "./jev-model-settings";
import { jevModelKey, type JevCatalogModel } from "./jev-model-catalog";

const row = (patch: Partial<JevCatalogModel>): JevCatalogModel => ({
  providerId: "typesafe", providerName: "TypeSafe", modelId: "jev-latest", name: "Jev",
  baseUrl: "https://example.test", source: "documented", ...patch,
});

describe("enabledJevModelKeys", () => {
  it("ignores undetected references without changing saved selections or selecting replacements", () => {
    const missing = { providerId: "commandcode", modelId: "typesafe/jev" };
    const detected = { providerId: "typesafe", modelId: "jev-latest" };
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered" as const, registeredModel: missing, enabledModels: [missing, detected] };
    expect(enabledJevModelKeys(settings, [row({}), row({ modelId: "jev-other" })])).toEqual(new Set([jevModelKey(detected)]));
    expect(enabledJevModelKeys(settings, [])).toEqual(new Set());
    expect(settings.enabledModels).toEqual([missing, detected]);
  });

  it("matches normalized LeafCodeCloud selections without enabling Sub as a replacement", () => {
    const settings = normalizeJevModelSettings({
      ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered",
      registeredModel: { providerId: "leafcodecloud", modelId: "jev-latest" },
    });
    const main = row({ providerId: "leafcodecloud", modelId: "LeafJev", name: "LeafJev" });
    const sub = row({ providerId: "leafcodecloud", modelId: "LeafJevSub", name: "LeafJevSub" });
    expect(enabledJevModelKeys(settings, [main, sub])).toEqual(new Set([jevModelKey(main)]));
    expect(enabledJevModelKeys(settings, [sub])).toEqual(new Set());
    expect(hasUsableJevModel({ settings, models: [{ ...main, providerEnabled: false }, sub] })).toBe(false);
  });

  it("matches account-specific keys and retains detected selections under disabled providers", () => {
    const ref = { providerId: "openrouter", modelId: "typesafe/jev", accountId: "one" };
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered" as const, registeredModel: ref };
    expect(enabledJevModelKeys(settings, [row({ ...ref, accountId: "two" })])).toEqual(new Set());
    expect(enabledJevModelKeys(settings, [row({ ...ref, providerEnabled: false })])).toEqual(new Set([jevModelKey(ref)]));
  });
});

describe("hasUsableJevModel", () => {
  it("treats legacy TypeSafe as usable whenever its credential is present", () => {
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, typesafeModel: "jev-1.14" };
    expect(hasUsableJevModel({ settings, models: [row({})] })).toBe(true);
    expect(hasUsableJevModel({ settings, models: [] })).toBe(false);
  });

  it("requires an enabled, discovered model for registered settings", () => {
    const ref = { providerId: "openrouter", modelId: "typesafe/jev" };
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered" as const, registeredModel: ref, enabledModels: [ref] };
    expect(hasUsableJevModel({ settings, models: [row({ ...ref, providerEnabled: true })] })).toBe(true);
    expect(hasUsableJevModel({ settings, models: [row({ ...ref, providerEnabled: false })] })).toBe(false);
    expect(hasUsableJevModel({ settings, models: [row({})] })).toBe(false);
  });
});

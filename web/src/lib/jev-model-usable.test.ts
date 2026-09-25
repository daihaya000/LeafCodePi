import { describe, expect, it } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS, hasUsableJevModel } from "./jev-model-settings";
import type { JevCatalogModel } from "./jev-model-catalog";

const row = (patch: Partial<JevCatalogModel>): JevCatalogModel => ({
  providerId: "typesafe", providerName: "TypeSafe", modelId: "jev-latest", name: "Jev",
  baseUrl: "https://example.test", source: "documented", ...patch,
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

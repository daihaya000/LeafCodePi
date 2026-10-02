import { describe, expect, it } from "vitest";
import { buildProviderModelsCatalog, mergeIntegratedProviderRows, providerDisplayName } from "./provider-models";

const state = { disabled: {}, providerOrder: [], modelOrder: {} };

describe("Codex provider display name", () => {
  it.each([
    ["OpenAI Codex (legacy)", "OpenAI Codex"],
    ["OpenAI Codex (Legacy)  ", "OpenAI Codex"],
    ["OpenAI Codex", "OpenAI Codex"],
    ["Custom Codex", "Custom Codex"],
  ])("formats %s without changing custom names", (name, expected) => {
    expect(providerDisplayName({ id: "openai-codex", name })).toBe(expected);
  });

  it("leaves other provider names unchanged", () => {
    expect(providerDisplayName({ id: "openai", name: "OpenAI" })).toBe("OpenAI");
    expect(providerDisplayName({ id: "custom", name: "Custom (legacy)" })).toBe("Custom (legacy)");
  });

  it("removes the suffix from separate and integrated catalogs without mutating the SDK provider", () => {
    const provider = { id: "openai-codex", name: "OpenAI Codex (legacy)" };
    const runtime = {
      getProviders: () => [provider],
      getModels: () => [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
      hasConfiguredAuth: () => true,
    };
    const first = buildProviderModelsCatalog(runtime, state, "account-1");
    const second = buildProviderModelsCatalog(runtime, state, "account-2");
    expect(first[0]).toMatchObject({ id: "openai-codex", name: "OpenAI Codex", accountId: "account-1" });
    expect(mergeIntegratedProviderRows([...first, ...second], state)).toMatchObject({
      id: "openai-codex", name: "OpenAI Codex", accountIds: ["account-1", "account-2"],
    });
    expect(provider.name).toBe("OpenAI Codex (legacy)");
  });
});

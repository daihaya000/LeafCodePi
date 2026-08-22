import { describe, expect, it } from "vitest";
import { attachCodexBarUsage, CODEXBAR_PROVIDER_MAP } from "./map";
import type { CodexBarProvider } from "@/lib/codexbar";
import type { ModelOption } from "@/lib/types";

function provider(id: string, usedPercent: number | null, maxed = false): CodexBarProvider {
  return {
    id,
    opencodeId: null,
    plan: null,
    planMonthlyUsd: null,
    usedPercent,
    limited: false,
    maxed,
    resetsAt: null,
    updatedAt: null,
    error: null,
    windows: [],
    credits: null,
  };
}

function model(providerID: string): ModelOption {
  return { value: `${providerID}::m`, label: "m", providerID, modelID: "m" };
}

describe("attachCodexBarUsage", () => {
  it("attaches percent / maxed for mapped providers", () => {
    const providers = [provider("claude", 80), provider("codex", 100, true)];
    const [claude] = attachCodexBarUsage([model("anthropic")], providers);
    expect(claude.codexbarUsedPercent).toBe(80);
    expect(claude.codexbarMaxed).toBe(false);

    const codexOptions = attachCodexBarUsage(
      [model("openai-codex"), model("llama-server")],
      providers,
    );
    expect(codexOptions[0].codexbarMaxed).toBe(true);
    expect(codexOptions[1].codexbarUsedPercent).toBeUndefined();
    expect(codexOptions[0].value).toBe("openai-codex::m");
  });

  it("returns options unchanged when usage is empty or unknown", () => {
    const options = [model("llama-server"), model("anthropic")];
    expect(attachCodexBarUsage(options, [])).toBe(options);

    const unknown = attachCodexBarUsage(options, [provider("cursor", 50)]);
    expect(unknown[0].codexbarUsedPercent).toBeUndefined();
    expect(unknown[1].codexbarUsedPercent).toBeUndefined();
  });
});

describe("CODEXBAR_PROVIDER_MAP coverage", () => {
  it("maps every subscription provider and skips local ones", () => {
    expect(CODEXBAR_PROVIDER_MAP["anthropic"]).toBe("claude");
    expect(CODEXBAR_PROVIDER_MAP["openai-codex"]).toBe("codex");
    expect(CODEXBAR_PROVIDER_MAP["cursor"]).toBe("cursor");
    expect(CODEXBAR_PROVIDER_MAP["ollama-cloud"]).toBe("ollama");
    expect(CODEXBAR_PROVIDER_MAP["commandcode"]).toBe("commandcode");
    expect(CODEXBAR_PROVIDER_MAP["qwen-cloud"]).toBe("qwen-cloud");
    expect(CODEXBAR_PROVIDER_MAP["openrouter"]).toBe("openrouter");
    expect(CODEXBAR_PROVIDER_MAP["synthetic"]).toBe("synthetic");
    // Local LLM providers have no rate limits.
    expect(CODEXBAR_PROVIDER_MAP["llama-server"]).toBeUndefined();
    expect(CODEXBAR_PROVIDER_MAP["llama.cpp"]).toBeUndefined();
  });
});

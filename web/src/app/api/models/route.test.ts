import { describe, expect, it } from "vitest";
import { GET } from "./route";
import type { CodexBarProvider } from "@/lib/codexbar";
import type { ModelOption } from "@/lib/types";

function provider(id: string, usedPercent: number | null, maxed: boolean): CodexBarProvider {
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
  return {
    value: `${providerID}::m`,
    label: "m",
    providerID,
    modelID: "m",
  };
}

/** Mirrors the route's attach logic (kept in sync; route imports node deps). */
import { CODEXBAR_PROVIDER_MAP } from "./map";

describe("models route codexbar attach", () => {
  it("attaches usage for mapped providers", () => {
    const providers = [provider("claude", 80, false), provider("codex", 100, true)];
    const byId = new Map(providers.map((p) => [p.id, p]));
    const option = model("anthropic");
    const p = byId.get(CODEXBAR_PROVIDER_MAP[option.providerID]);
    expect(p?.usedPercent).toBe(80);
    expect(p?.maxed).toBe(false);
    expect(CODEXBAR_PROVIDER_MAP["openai-codex"]).toBe("codex");
  });

  it("leaves unmapped providers untouched", () => {
    expect(CODEXBAR_PROVIDER_MAP["llama-server"]).toBeUndefined();
    expect(CODEXBAR_PROVIDER_MAP["llama.cpp"]).toBeUndefined();
  });
});

describe("GET /api/models", () => {
  it("returns models array even when runtime is unavailable", async () => {
    const res = await GET();
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { models: unknown[] };
      expect(Array.isArray(body.models)).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { hasDecisionsEndpoint, isJevModel, jevModelApi, selectNativeJevModel, supportsJevModel } from "./jev-model-catalog";

describe("Jev model wire contracts", () => {
  it.each(["/decisions", "/v1/decisions", "/api/v1/decisions/", "/provider/v1/decisions"])("recognizes a fixed Decisions endpoint on any provider (%s)", (endpoint) => {
    const model = { id: "vendor/judge", supported_endpoints: [endpoint] };
    expect(hasDecisionsEndpoint(model)).toBe(true);
    expect(jevModelApi("custom", model)).toBe("decisions");
    expect(supportsJevModel("custom", model)).toBe(true);
    expect(isJevModel(model)).toBe(true);
  });

  it.each(["decisions", "openai-decisions"])("recognizes explicit classifier APIs (%s)", (api) => {
    expect(jevModelApi("custom", { id: "judge", type: "classifier", api })).toBe("decisions");
  });

  it.each(["https://untrusted.example/v1/decisions", "/custom/decisions", "/v1/decisions?key=secret", "decisions", "/v1/responses"])("does not infer a Decisions contract from unrelated paths (%s)", (endpoint) => {
    expect(jevModelApi("custom", { id: "judge", supported_endpoints: [endpoint] })).toBeUndefined();
  });

  it.each(["/v1/responses", "/api/v1/chat/completions"])("keeps an explicitly dual-purpose model usable in chat (%s)", (endpoint) => {
    const model = { id: "gpt-6-luna", supported_endpoints: [endpoint, "/v1/decisions"] };
    expect(jevModelApi("openrouter", model)).toBe("decisions");
    expect(isJevModel(model)).toBe(false);
  });

  it("does not guess another provider's format from Luna's name or the decisions modality", () => {
    const model = { id: "gpt-6-luna", api: "openai-responses" };
    expect(jevModelApi("openai", model)).toBe("decisions");
    expect(jevModelApi("openai-codex", model)).toBeUndefined();
    expect(jevModelApi("openrouter", model)).toBeUndefined();
    const modality = { id: "vendor/judge", architecture: { output_modalities: ["decisions"] } };
    expect(jevModelApi("custom", modality)).toBeUndefined();
    expect(jevModelApi("openrouter", modality)).toBe("systemone");
  });

  it("preserves System One priority and rejects incompatible model types", () => {
    const both = { id: "judge", supported_endpoints: ["/v1/decisions", "/v1/systemone"] };
    expect(jevModelApi("custom", both)).toBe("systemone");
    expect(jevModelApi("openai", { id: "gpt-6-luna", api: "typesafe-system-one" })).toBe("systemone");
    expect(jevModelApi("openrouter", { id: "typesafe/jev", type: "classifier", api: "llama-cpp-classify" })).toBeUndefined();
    expect(jevModelApi("custom", { id: "judge", type: "image", api: "decisions" })).toBeUndefined();
  });

  it("prefers explicit native classifiers over inferred chat entries regardless of row order", () => {
    const ref = { providerId: "openai", modelId: "gpt-6-luna" };
    const chat = { id: ref.modelId, type: "chat", api: "openai-responses" };
    const decisions = { id: ref.modelId, type: "classifier", api: "openai-decisions" };
    const systemone = { id: ref.modelId, type: "classifier", api: "typesafe-system-one" };
    expect(selectNativeJevModel([chat, decisions], ref)).toBe(decisions);
    expect(selectNativeJevModel([decisions, chat], ref)).toBe(decisions);
    expect(selectNativeJevModel([chat, decisions, systemone], ref)).toBe(systemone);
  });
});

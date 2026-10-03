import { describe, expect, it, vi } from "vitest";
import {
  EXPERIENTIALLABS_BASE_URL,
  EXPERIENTIALLABS_PROVIDER_ID,
  inferExperientialLabsCapabilities,
  parseExperientialLabsModelsPayload,
  registerExperientialLabsProvider,
  toExperientialLabsModel,
} from "./experientiallabs-provider";

describe("experientiallabs-provider", () => {
  it("parses /v1/models payloads and keeps ids exactly as returned", () => {
    expect(
      parseExperientialLabsModelsPayload({
        object: "list",
        data: [
          { id: "qwen3.8-27b" },
          { id: "  spaced-id  " },
          { id: 1 },
          { id: "" },
          null,
        ],
      }),
    ).toEqual(["qwen3.8-27b", "spaced-id"]);
    expect(parseExperientialLabsModelsPayload(null)).toEqual([]);
    expect(parseExperientialLabsModelsPayload({ data: "nope" })).toEqual([]);
  });

  it("builds openai-completions models for Experiential Labs", () => {
    const model = toExperientialLabsModel("qwen3.8-27b");
    expect(model).toMatchObject({
      id: "qwen3.8-27b",
      name: "qwen3.8-27b",
      provider: EXPERIENTIALLABS_PROVIDER_ID,
      api: "openai-completions",
      baseUrl: EXPERIENTIALLABS_BASE_URL,
      reasoning: true,
    });
  });

  it("infers vision / reasoning hints from ids", () => {
    expect(inferExperientialLabsCapabilities("qwen2.5-vl-7b").input).toContain("image");
    expect(inferExperientialLabsCapabilities("deepseek-r1").reasoning).toBe(true);
    expect(inferExperientialLabsCapabilities("llama3-8b").input).toEqual(["text"]);
  });

  it("registers once and refreshes the live catalog", async () => {
    const providers = new Map<string, unknown>();
    const runtime = {
      getProvider: (id: string) => providers.get(id),
      registerNativeProvider: vi.fn((provider: { id: string }) => {
        providers.set(provider.id, provider);
      }),
      refresh: vi.fn(async () => undefined),
    };
    await registerExperientialLabsProvider(runtime as never);
    expect(runtime.registerNativeProvider).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ providers: [EXPERIENTIALLABS_PROVIDER_ID] }),
    );
    await registerExperientialLabsProvider(runtime as never);
    expect(runtime.registerNativeProvider).toHaveBeenCalledTimes(1);
  });
});

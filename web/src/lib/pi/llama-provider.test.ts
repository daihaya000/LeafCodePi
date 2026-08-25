import { describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchLlamaServerModelIds,
  isLlamaOrnithModel,
  isLlamaQwenReasoningModel,
  rewriteLlamaServerEffortPayload,
} from "@/lib/pi/llama-provider";
import { thinkingLevelsForModel } from "@/lib/thinking-levels";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  LLAMA_ORNITH_THINKING_LEVEL_MAP,
  LLAMA_QWEN_THINKING_LEVEL_MAP,
} from "@/lib/pi/llama-provider";

describe("fetchLlamaServerModelIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads ids from /models and prefers loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toContain("/models");
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "unloaded-one", status: { value: "unloaded" } },
              { id: "ready-one", status: { value: "loaded" } },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    await expect(fetchLlamaServerModelIds("http://127.0.0.1:8081")).resolves.toEqual(["ready-one"]);
  });

  it("returns empty when the server is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(fetchLlamaServerModelIds()).resolves.toEqual([]);
  });
});

describe("isLlamaQwenReasoningModel", () => {
  it("detects Qwen3.8 GGUF aliases", () => {
    expect(isLlamaQwenReasoningModel("Qwen3.8-27B-Uncensored-GGUF")).toBe(true);
    expect(isLlamaQwenReasoningModel("Qwen3.8-27B-Uncensored-GGUF.gguf")).toBe(true);
    expect(isLlamaQwenReasoningModel("Huihui-Qwen3.8-27B-abliterated-GGUF")).toBe(true);
    expect(isLlamaQwenReasoningModel("C:\\models\\Qwen3-32B-Q4_K_M.gguf")).toBe(true);
  });

  it("rejects non-Qwen3 ids", () => {
    expect(isLlamaQwenReasoningModel("llama-3.1-8b")).toBe(false);
    expect(isLlamaQwenReasoningModel("qwen2.5-7b")).toBe(false);
  });
});

describe("rewriteLlamaServerEffortPayload", () => {
  it("moves graded effort into chat_template_kwargs", () => {    expect(
      rewriteLlamaServerEffortPayload(
        {
          model: "Qwen3.8-27B-Uncensored-GGUF",
          reasoning_effort: "medium",
          messages: [{ role: "user", content: "hi" }],
        },
        { id: "Qwen3.8-27B-Uncensored-GGUF", reasoning: true },
      ),
    ).toEqual({
      model: "Qwen3.8-27B-Uncensored-GGUF",
      messages: [{ role: "user", content: "hi" }],
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
  });

  it("forces top-level none and /no_think when effort is off", () => {
    expect(
      rewriteLlamaServerEffortPayload(
        {
          model: "Qwen3.8-27B-Uncensored-GGUF",
          reasoning_effort: "none",
          chat_template_kwargs: { reasoning_effort: "xhigh", other: 1 },
          messages: [{ role: "user", content: "hi" }],
        },
        { id: "Qwen3.8-27B-Uncensored-GGUF", reasoning: true },
      ),
    ).toEqual({
      model: "Qwen3.8-27B-Uncensored-GGUF",
      reasoning_effort: "none",
      chat_template_kwargs: { other: 1 },
      messages: [{ role: "user", content: "/no_think\nhi" }],
    });
  });

  it("leaves non-reasoning models unchanged", () => {
    const payload = { reasoning_effort: "medium", messages: [] };
    expect(rewriteLlamaServerEffortPayload(payload, { reasoning: false })).toBe(payload);
  });
});

describe("Ornith-1.5 GGUFs", () => {
  const ornithId = "Ornith-1.5-35B-A3B-AD-Q5_K-Q4_K";

  it("detects Ornith ids", () => {
    expect(isLlamaOrnithModel(ornithId)).toBe(true);
    expect(isLlamaOrnithModel("ornith-1.5-9b.gguf")).toBe(true);
    expect(isLlamaOrnithModel("Qwen3.8-27B-Uncensored-GGUF")).toBe(false);
  });

  it("maps minimal to enable_thinking=false kwargs", () => {
    expect(
      rewriteLlamaServerEffortPayload(
        {
          model: ornithId,
          reasoning_effort: "no_think",
          messages: [{ role: "user", content: "hi" }],
        },
        { id: ornithId, reasoning: true },
      ),
    ).toEqual({
      model: ornithId,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("keeps the template default (thinking on) for off and strips effort", () => {
    expect(
      rewriteLlamaServerEffortPayload(
        {
          model: ornithId,
          reasoning_effort: "none",
          messages: [{ role: "user", content: "hi" }],
        },
        { id: ornithId, reasoning: true },
      ),
    ).toEqual({
      model: ornithId,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("exposes off/minimal thinking levels only", () => {
    const model = {
      id: ornithId,
      name: ornithId,
      api: "openai-completions",
      provider: "llama-server",
      baseUrl: "http://127.0.0.1:8081/v1",
      reasoning: true,
      thinkingLevelMap: { ...LLAMA_ORNITH_THINKING_LEVEL_MAP },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    } as Model<Api>;
    expect(thinkingLevelsForModel(model)).toEqual(["off", "minimal"]);
  });
});

describe("Qwen llama thinking levels", () => {
  it("exposes off/low/medium/xhigh for Qwen3 models", () => {
    const model = {
      id: "Qwen3.8-27B-Uncensored-GGUF",
      name: "Qwen3.8-27B-Uncensored-GGUF",
      api: "openai-completions",
      provider: "llama-server",
      baseUrl: "http://127.0.0.1:8081/v1",
      reasoning: true,
      thinkingLevelMap: { ...LLAMA_QWEN_THINKING_LEVEL_MAP },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    } as Model<Api>;
    expect(thinkingLevelsForModel(model)).toEqual(["off", "low", "medium", "xhigh"]);
  });
});

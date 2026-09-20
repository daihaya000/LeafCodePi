import { rmSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  appendLlamaServerSystemPrompt,
  displayName,
  fetchLlamaServerModels,
  isLlamaOrnithModel,
  isLlamaQwenReasoningModel,
  registerLlamaProviders,
  rewriteLlamaServerEffortPayload,
  syncLlamaServerProvider,
  LLAMA_ORNITH_THINKING_LEVEL_MAP,
  LLAMA_QWEN_THINKING_LEVEL_MAP,
} from "@/lib/pi/llama-provider";
import { settingsPath, writeSettingValue } from "@/lib/host-control";
import {
  DEFAULT_LLAMA_SERVER_SETTINGS,
  LLAMA_SERVER_SETTINGS_KEY,
  serializeLlamaServerSettings,
} from "@/lib/llama-server-settings";
import { thinkingLevelsForModel } from "@/lib/thinking-levels";
import type { Api, Model } from "@earendil-works/pi-ai";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchLlamaServerModels", () => {
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
    await expect(fetchLlamaServerModels("http://127.0.0.1:8081")).resolves.toEqual([
      { id: "ready-one", status: "loaded", image: false },
    ]);
  });

  it("merges data[] status with models[] multimodal capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "vision-model", status: { value: "loaded" }, owned_by: "llamacpp" },
              { id: "text-model", status: { value: "loaded" }, owned_by: "llamacpp" },
            ],
            models: [
              { name: "vision-model", capabilities: ["completion", "multimodal"] },
              { name: "text-model", capabilities: ["completion"] },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(fetchLlamaServerModels("http://127.0.0.1:8081")).resolves.toEqual([
      { id: "vision-model", status: "loaded", image: true },
      { id: "text-model", status: "loaded", image: false },
    ]);
  });

  it("returns empty when the server is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(fetchLlamaServerModels()).resolves.toEqual([]);
  });
});

describe("displayName", () => {
  it("removes the GGUF extension and quantization suffix", () => {
    expect(
      displayName("C:\\models\\Qwen3.8-27B-Uncensored-Q4_K_S.gguf"),
    ).toBe("Qwen3.8 27B Uncensored");
    expect(displayName("Ternary-Bonsai-2-27B-PTQ1_0")).toBe(
      "OrcaBonsai 27B Uncensored",
    );
  });
});

describe("registerLlamaProviders", () => {
  it("registers llama-server without the built-in llama.cpp provider", async () => {
    vi.stubEnv("LLAMA_BASE_URL", "http://example.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "local-model", status: { value: "loaded" } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const registerNativeProvider = vi.fn();
    const registerProvider = vi.fn();
    const runtime = { registerNativeProvider, registerProvider };

    await registerLlamaProviders(runtime);

    expect(registerNativeProvider).not.toHaveBeenCalled();
    expect(registerProvider).toHaveBeenCalledWith(
      "llama-server",
      expect.objectContaining({
        name: "llama-server",
        models: [expect.objectContaining({ id: "local-model", input: ["text"] })],
      }),
    );
    expect(process.env.LLAMA_BASE_URL).toBe("http://example.invalid");
  });

  it.each([true, false])("serializes image input through the real SDK (multimodal=%s)", async (image) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "Qwen3.8-27B-Uncensored",
                status: { value: "loaded" },
              },
            ],
            models: [{
              name: "Qwen3.8-27B-Uncensored",
              capabilities: image ? ["completion", "multimodal"] : ["completion"],
            }],
          }),
          { status: 200 },
        ),
      ),
    );
    const registerProvider = vi.fn();

    await registerLlamaProviders({ registerProvider });

    const [provider, config] = registerProvider.mock.calls[0] as [string, {
      baseUrl: string;
      api: Api;
      models: Model<Api>[];
      streamSimple: typeof import("@earendil-works/pi-ai/compat").streamSimple;
    }];
    const model = { ...config.models[0], provider, baseUrl: config.baseUrl, api: config.api };
    expect(model.input).toEqual(image ? ["text", "image"] : ["text"]);

    const onPayload = vi.fn<(payload: unknown) => never>(() => {
      throw new Error("payload captured; no network request");
    });
    const result = await config.streamSimple(model, {
      messages: [
        // A historical denial must not control the current model's image support.
        { role: "user", content: "Earlier reply: (image omitted: model does not support images)", timestamp: 1 },
        { role: "user", content: [
          { type: "text", text: "Transcribe the attached image." },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ], timestamp: 2 },
      ],
    }, { apiKey: "local", onPayload }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("payload captured; no network request");
    expect(onPayload).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const payload = onPayload.mock.calls[0][0] as {
      messages: { role: string; content: unknown }[];
    };
    const latest = payload.messages.filter((message) => message.role === "user").at(-1)!;
    if (image) {
      expect(latest.content).toEqual(expect.arrayContaining([
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ]));
      expect(JSON.stringify(latest.content)).not.toContain("image omitted");
    } else {
      expect(JSON.stringify(latest.content)).toContain("image omitted: model does not support images");
      expect(JSON.stringify(latest.content)).not.toContain("image_url");
    }
  });

  it("registers no models while the server is stopped, even with a configured model file", async () => {
    writeSettingValue(
      LLAMA_SERVER_SETTINGS_KEY,
      serializeLlamaServerSettings({
        ...DEFAULT_LLAMA_SERVER_SETTINGS,
        modelFile: "Qwen3.8-27B-Uncensored-GGUF.gguf",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const registerProvider = vi.fn();
    try {
      await syncLlamaServerProvider({ registerProvider });
      expect(registerProvider).toHaveBeenCalledWith("llama-server", expect.objectContaining({ models: [] }));
    } finally {
      rmSync(settingsPath(LLAMA_SERVER_SETTINGS_KEY), { force: true });
    }
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

describe("appendLlamaServerSystemPrompt", () => {
  it("appends the configured prompt without mutating the Pi context", () => {
    const context = {
      systemPrompt: "Pi's instructions",
      messages: [],
    };
    const result = appendLlamaServerSystemPrompt(context, "  Local model instructions  ");
    expect(result).toEqual({
      systemPrompt: "Pi's instructions\n\nLocal model instructions",
      messages: [],
    });
    expect(context.systemPrompt).toBe("Pi's instructions");
  });

  it("returns the original context when the setting is empty", () => {
    const context = { systemPrompt: "Pi's instructions", messages: [] };
    expect(appendLlamaServerSystemPrompt(context, "  ")).toBe(context);
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

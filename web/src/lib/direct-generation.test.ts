import { afterEach, describe, expect, it, vi } from "vitest";

const { completeModelText } = vi.hoisted(() => ({
  completeModelText: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({ completeModelText }));

import {
  buildDirectGenerationCandidates,
  extractDirectText,
  generateDirectText,
  generateDirectTextWithFallback,
  generateDirectTextWithFallbackResult,
  parseDirectModel,
} from "./direct-generation";

describe("direct-generation", () => {
  afterEach(() => {
    completeModelText.mockReset();
    vi.unstubAllGlobals();
  });

  it("extracts string and block-based chat completion text", () => {
    expect(extractDirectText({ choices: [{ message: { content: " hello " } }] })).toBe("hello");
    expect(
      extractDirectText({
        choices: [{ message: { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] } }],
      }),
    ).toBe("one\ntwo");
    expect(extractDirectText({ choices: [] })).toBe("");
  });

  it("preserves the selected account in a direct model object", () => {
    expect(
      parseDirectModel({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        accountId: " acc-1 ",
      }),
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
      accountId: "acc-1",
    });
  });

  it("uses Pi's runtime directly for Ollama Cloud", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    completeModelText.mockResolvedValue(" API direct ");

    await expect(
      generateDirectText({
        model: { providerID: "ollama-cloud", modelID: "qwen3" },
        accountId: "acc-1",
        system: "system",
        prompt: "prompt",
        maxTokens: 64,
        effort: "high",
      }),
    ).resolves.toBe("API direct");
    expect(completeModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerID: "ollama-cloud",
        modelID: "qwen3",
        accountId: "acc-1",
        system: "system",
        prompt: "prompt",
        maxTokens: 64,
        reasoning: "high",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the OpenAI-compatible endpoint without tools", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(_input)).toBe("http://127.0.0.1:8081/v1/chat/completions");
      expect(body).toMatchObject({ model: "local-model", stream: false, max_tokens: 64 });
      expect(body.tools).toBeUndefined();
      return new Response(JSON.stringify({ choices: [{ message: { content: "更新 foo" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateDirectText({
        model: { providerID: "llama-server", modelID: "local-model" },
        system: "system",
        prompt: "prompt",
        maxTokens: 64,
      }),
    ).resolves.toBe("更新 foo");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves local Qwen defaults unchanged without an effort setting", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.chat_template_kwargs).toBeUndefined();
      return new Response(JSON.stringify({ choices: [{ message: { content: "更新 foo" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateDirectText({
        model: { providerID: "llama-server", modelID: "Qwen3.8-27B-Uncensored-GGUF" },
        system: "system",
        prompt: "prompt",
      }),
    ).resolves.toBe("更新 foo");
  });

  it("maps local Qwen effort into the llama-server chat template", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "更新 foo" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateDirectText({
        model: { providerID: "llama-server", modelID: "Qwen3.8-27B-Uncensored-GGUF" },
        system: "system",
        prompt: "prompt",
        effort: "medium",
      }),
    ).resolves.toBe("更新 foo");
  });

  it("returns a bounded provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
      ),
    );

    await expect(
      generateDirectText({
        model: { providerID: "llama-server", modelID: "local-model" },
        system: "system",
        prompt: "prompt",
      }),
    ).rejects.toMatchObject({ status: 400, message: "プロバイダー応答エラー (400)" });
  });

  it("builds distinct primary and fallback candidates", () => {
    const primary = { providerID: "llama-server", modelID: "primary" };
    const fallback = { providerID: "llama-server", modelID: "fallback" };
    expect(
      buildDirectGenerationCandidates({
        primary,
        primaryEffort: "low",
        fallback,
        fallbackEffort: "high",
      }),
    ).toEqual([
      { model: primary, effort: "low" },
      { model: fallback, effort: "high" },
    ]);
    expect(buildDirectGenerationCandidates({ primary, fallback: primary })).toEqual([
      { model: primary },
    ]);
  });

  it("retries a provider 5xx without the reasoning effort", async () => {
    completeModelText
      .mockRejectedValueOnce(new Error('500: {"type":"error","message":"Internal server error"}'))
      .mockResolvedValueOnce("fallback result");

    await expect(
      generateDirectTextWithFallback({
        candidates: [{ model: { providerID: "opencode-go", modelID: "mimo-v2.5" }, effort: "minimal" }],
        system: "system",
        prompt: "prompt",
      }),
    ).resolves.toBe("fallback result");
    expect(completeModelText).toHaveBeenCalledTimes(2);
    expect(completeModelText.mock.calls[0]?.[0]).toMatchObject({ reasoning: "minimal" });
    expect(completeModelText.mock.calls[1]?.[0]).not.toHaveProperty("reasoning");
  });

  it("tries the selected fallback model with its own effort", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("Qwen3.8-27B-Uncensored-GGUF");
        expect(body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
        return new Response(JSON.stringify({ choices: [{ message: { content: "fallback result" } }] }), {
          status: 200,
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateDirectTextWithFallbackResult({
        candidates: [
          { model: { providerID: "llama-server", modelID: "primary" }, effort: "low" },
          { model: { providerID: "llama-server", modelID: "Qwen3.8-27B-Uncensored-GGUF" }, effort: "medium" },
        ],
        system: "system",
        prompt: "prompt",
      }),
    ).resolves.toEqual({
      text: "fallback result",
      model: { providerID: "llama-server", modelID: "Qwen3.8-27B-Uncensored-GGUF" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

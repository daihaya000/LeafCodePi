import { afterEach, describe, expect, it, vi } from "vitest";

const { completeModelText } = vi.hoisted(() => ({
  completeModelText: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({ completeModelText }));

import {
  extractDirectText,
  generateDirectText,
  resolveDirectModel,
} from "./direct-generation";

describe("direct-generation", () => {
  afterEach(() => {
    completeModelText.mockReset();
    vi.unstubAllGlobals();
  });

  it("resolves only fixed direct provider endpoints", () => {
    expect(resolveDirectModel({ providerID: "llama-server", modelID: "local-model" })).toEqual({
      providerID: "llama-server",
      modelID: "local-model",
      baseUrl: "http://127.0.0.1:8081/v1",
      apiKey: "local",
    });
    expect(() =>
      resolveDirectModel({ providerID: "arbitrary", modelID: "http://169.254.169.254" }),
    ).toThrow("未対応");
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

  it("uses Pi's runtime directly for Ollama Cloud", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    completeModelText.mockResolvedValue(" API direct ");

    await expect(
      generateDirectText({
        model: { providerID: "ollama-cloud", modelID: "qwen3" },
        system: "system",
        prompt: "prompt",
        maxTokens: 64,
      }),
    ).resolves.toBe("API direct");
    expect(completeModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerID: "ollama-cloud",
        modelID: "qwen3",
        system: "system",
        prompt: "prompt",
        maxTokens: 64,
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
});

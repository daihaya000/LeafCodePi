import { describe, expect, it, vi } from "vitest";
import { applyLlamaVisionToProviderModels, llamaServerImageModelIds } from "./llama-server-vision";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("llama-server-vision", () => {
  it("collects only the models reporting multimodal capabilities", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        models: [
          { name: "Qwen3.8-27B-Uncensored-Q4_K_S", capabilities: ["completion", "multimodal"] },
          { name: "text-only-model", capabilities: ["completion"] },
        ],
      }),
    ) as unknown as typeof fetch;

    const ids = await llamaServerImageModelIds({ baseUrl: "http://127.0.0.1:8081", fetchFn });

    expect([...ids]).toEqual(["Qwen3.8-27B-Uncensored-Q4_K_S"]);
    const calls = (fetchFn as unknown as { mock: { calls: [string, unknown][] } }).mock.calls;
    expect(calls[0]![0]).toBe("http://127.0.0.1:8081/v1/models");
  });

  it("normalizes a base URL that already carries /v1", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [] })) as unknown as typeof fetch;
    await llamaServerImageModelIds({ baseUrl: "http://127.0.0.1:8081/v1/", fetchFn });
    const calls = (fetchFn as unknown as { mock: { calls: [string, unknown][] } }).mock.calls;
    expect(calls[0]![0]).toBe("http://127.0.0.1:8081/v1/models");
  });

  it("returns an empty set when llama-server is unreachable or answers an error", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect([...(await llamaServerImageModelIds({ baseUrl: "http://127.0.0.1:9", fetchFn: failing }))]).toEqual([]);

    const erroring = vi.fn(async () => jsonResponse({}, false)) as unknown as typeof fetch;
    expect([...(await llamaServerImageModelIds({ baseUrl: "http://127.0.0.1:9", fetchFn: erroring }))]).toEqual([]);

    const malformed = vi.fn(async () => jsonResponse({ models: "nope" })) as unknown as typeof fetch;
    expect([...(await llamaServerImageModelIds({ baseUrl: "http://127.0.0.1:9", fetchFn: malformed }))]).toEqual([]);
  });
});

describe("applyLlamaVisionToProviderModels", () => {
  function makeRuntime() {
    let models: { id?: unknown; input?: unknown }[] = [];
    const provider: { id: string; getModels: () => readonly unknown[] } = {
      id: "llama-server",
      getModels: () => models,
    };
    return {
      provider,
      runtime: { getProviders: () => [provider], getModels: () => models },
      setModels(next: { id?: unknown; input?: unknown }[]) {
        models = next;
      },
      models(): { id?: unknown; input?: unknown }[] {
        return models;
      },
    };
  }

  it("adds image to multimodal models and survives a model refresh", () => {
    const harness = makeRuntime();
    const id = "Qwen3.8-27B-Uncensored-Q4_K_S";
    harness.setModels([{ id, input: ["text"] }]);

    expect(applyLlamaVisionToProviderModels(harness.runtime, new Set([id]))).toBe(1);
    expect(harness.provider.getModels()[0]).toMatchObject({ input: ["text", "image"] });

    // refreshModels 相当で配列ごと差し替わっても、ラップした getModels 経由で再付与される。
    harness.setModels([{ id, input: ["text"] }]);
    expect(harness.provider.getModels()[0]).toMatchObject({ input: ["text", "image"] });
    // 2回目の適用でも重複しない
    expect(applyLlamaVisionToProviderModels(harness.runtime, new Set([id]))).toBe(1);
    expect(harness.models()[0]!.input).toEqual(["text", "image"]);
  });

  it("ignores providers that are not llama.cpp/llama-server", () => {
    const other = { id: "anthropic", getModels: () => [{ id: "m", input: ["text"] }] };
    const runtime = { getProviders: () => [other], getModels: () => other.getModels() };

    expect(applyLlamaVisionToProviderModels(runtime, new Set(["m"]))).toBe(0);
    expect(other.getModels()[0]!.input).toEqual(["text"]);
  });

  it("removes only the image entry it added when the projector is gone", () => {
    const harness = makeRuntime();
    harness.setModels([
      { id: "vision", input: ["text"] },
      { id: "native", input: ["text", "image"] },
    ]);

    applyLlamaVisionToProviderModels(harness.runtime, new Set(["vision"]));
    expect(harness.models()[0]!.input).toEqual(["text", "image"]);

    // mmproj を外した起動に戻った: 我々が足した分だけ取り消し、プロバイダ設定の image は残す。
    applyLlamaVisionToProviderModels(harness.runtime, new Set());
    expect(harness.models()[0]!.input).toEqual(["text"]);
    expect(harness.models()[1]!.input).toEqual(["text", "image"]);
  });
});

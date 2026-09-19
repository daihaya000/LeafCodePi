import { describe, expect, it, vi } from "vitest";
import { llamaServerImageModelIds } from "./llama-server-vision";

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

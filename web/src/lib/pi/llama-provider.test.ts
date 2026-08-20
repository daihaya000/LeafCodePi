import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchLlamaServerModelIds } from "@/lib/pi/llama-provider";

describe("fetchLlamaServerModelIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads ids from /v1/models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toContain("/v1/models");
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "C:\\\\models\\\\Qwen.gguf", object: "model" }],
          }),
          { status: 200 },
        );
      }),
    );
    await expect(fetchLlamaServerModelIds("http://127.0.0.1:8081")).resolves.toEqual([
      "C:\\\\models\\\\Qwen.gguf",
    ]);
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

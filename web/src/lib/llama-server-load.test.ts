import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLlamaServerModelLoaded } from "./llama-server-load";

const catalog = (models: Array<{ id: string; status: string }>) => ({
  ok: true,
  json: async () => ({ data: models.map((model) => ({ id: model.id, status: { value: model.status } })) }),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ensureLlamaServerModelLoaded", () => {
  it("returns immediately when a model is already loaded", async () => {
    const fetchImpl = vi.fn(async () => catalog([{ id: "a", status: "loaded" }]));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(ensureLlamaServerModelLoaded({ baseUrl: "http://127.0.0.1:9/v1" })).resolves.toEqual({ ok: true, modelId: "a" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load instead of starting a second wait", async () => {
    let loaded = false;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") return { ok: true };
      if (loaded) return catalog([{ id: "a", status: "loaded" }]);
      return catalog([{ id: "a", status: "unloaded" }]);
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.useFakeTimers();

    const first = ensureLlamaServerModelLoaded({ baseUrl: "http://127.0.0.1:10" });
    const second = ensureLlamaServerModelLoaded({ baseUrl: "http://127.0.0.1:10" });
    // Only one catalog read and one load request so far: the second caller joined.
    await vi.advanceTimersByTimeAsync(0);
    const posts = fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);

    loaded = true;
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(first).resolves.toEqual({ ok: true, modelId: "a" });
    await expect(second).resolves.toEqual({ ok: true, modelId: "a" });
    expect(fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);

    // A later call starts its own load cycle once the shared one settled.
    await expect(ensureLlamaServerModelLoaded({ baseUrl: "http://127.0.0.1:10" })).resolves.toEqual({ ok: true, modelId: "a" });
    expect(fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
  });

  it("keeps different server roots and preferences independent", async () => {
    const fetchImpl = vi.fn(async () => catalog([{ id: "a", status: "loaded" }]));
    vi.stubGlobal("fetch", fetchImpl);

    await Promise.all([
      ensureLlamaServerModelLoaded({ baseUrl: "http://127.0.0.1:11" }),
      ensureLlamaServerModelLoaded({ baseUrl: "http://127.0.0.1:12" }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
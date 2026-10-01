import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getJson, sendJson } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("getJson", () => {
  it.each(["get", "send"])("preserves structured Backend failure details on %s", async (method) => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Backendへ転送できません", code: "BACKEND_FORWARD_FAILED", reason: "bad-response",
    }), { status: 502 })));
    const request = method === "get" ? getJson("/api/test") : sendJson("/api/test", {});
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({ status: 502, code: "BACKEND_FORWARD_FAILED", reason: "bad-response" });
  });

  it("retains ordinary non-JSON HTTP errors", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid", { status: 503, statusText: "Unavailable" })));
    await expect(sendJson("/api/test", {})).rejects.toMatchObject({ message: "Unavailable", status: 503 });
  });

  it("coalesces simultaneous GETs and removes the request after completion", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });

    let resolveFetch!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    const json = vi.fn().mockResolvedValue({ value: 1 });
    const fetchMock = vi.fn(
      () => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = getJson<{ value: number }>("/api/models");
    const second = getJson<{ value: number }>("/api/models");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json });
    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 1 }, { value: 1 }]);
    expect(json).toHaveBeenCalledTimes(1);

    const third = getJson<{ value: number }>("/api/models");
    resolveFetch({ ok: true, json });
    await expect(third).resolves.toEqual({ value: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes the external abort listener after a timed request settles", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      sendJson("/api/test", { value: 1 }, "POST", { timeoutMs: 1_000, signal }),
    ).resolves.toEqual({ ok: true });

    const listener = addEventListener.mock.calls[0]?.[1];
    expect(listener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", listener);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearEtagBodiesForTest, getJson, sendJson, sendTaskPrompt } from "./client";

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

  it("passes an explicit abort signal through to GET requests", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson("/api/test", undefined, { coalesce: false, signal })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/test", expect.objectContaining({ signal }));
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

  it("aborts a stalled task prompt and marks delivery as uncertain timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", { location: { origin: "http://localhost" } });
      const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }));
      vi.stubGlobal("fetch", fetchMock);

      const request = sendTaskPrompt("/api/tasks/task-1/prompt", { prompt: "hello" }, 1_000);
      const timeoutAssertion = expect(request).rejects.toMatchObject({ status: 408, reason: "timeout" });
      await vi.advanceTimersByTimeAsync(1_000);
      await timeoutAssertion;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost/api/tasks/task-1/prompt",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getJson conditional GET", () => {
  afterEach(() => clearEtagBodiesForTest());

  it("revalidates with If-None-Match and reuses the remembered body on 304", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [{ id: "t1" }] }), { status: 200, headers: { etag: 'W/"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: 'W/"v1"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { etag: 'W/"v2"' } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getJson<{ tasks: { id: string }[] }>("/api/tasks");
    const second = await getJson<{ tasks: { id: string }[] }>("/api/tasks");
    expect(second).toEqual(first);
    // Each caller receives its own object, so a caller's mutation cannot leak into the next poll.
    expect(second).not.toBe(first);
    await expect(getJson("/api/tasks")).resolves.toEqual({ tasks: [] });
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("headers");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ headers: { "if-none-match": 'W/"v1"' } });
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ headers: { "if-none-match": 'W/"v1"' } });
  });

  it("does not send If-None-Match for responses without an ETag", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getJson("/api/plain");
    await getJson("/api/plain");
    expect(fetchMock.mock.calls[1]![1]).not.toHaveProperty("headers");
  });
});
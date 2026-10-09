import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayProviderLoginEvents } from "./provider-auth-events-relay";
const mock = vi.hoisted(() => ({ fetch: vi.fn(), agent: vi.fn() }));
vi.mock("undici", () => ({ fetch: mock.fetch, Agent: class { constructor(options: unknown) { mock.agent(options); } } }));
const fetcher = mock.fetch;
const sseHeaders = { "content-type": "text/event-stream", "x-leafcode-backend-protocol": "1" };
beforeEach(() => {
  for (const [key, value] of Object.entries({ LEAFCODE_PI_WEBUI_AUTH: "", LEAFCODE_PI_WEBUI_TOKEN: "", LEAFCODE_PI_BACKEND_TOKEN: "owner-private-token-1234567890123456789", LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "" })) vi.stubEnv(key, value);
  fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
it("relays opaque owner SSE/query and strips private owner/browser headers", async () => {
  const bytes = 'event: started\ndata: {"sessionId":"s"}\n\nevent: done\ndata: {"ok":true}\n\n';
  fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { ...sseHeaders, "set-cookie": "PRIVATE" } }));
  const result = await relayProviderLoginEvents(new Request("http://localhost/api/providers/a%2Fb/login/events?sessionId=s", { headers: { cookie: "BROWSER", authorization: "BROWSER" } }), "a%2Fb");
  expect(await result.text()).toBe(bytes); expect(result.headers.get("set-cookie")).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toContain("/provider-login-events/a%2Fb?sessionId=s");
  expect(fetcher.mock.calls[0][1].headers.cookie).toBeUndefined(); expect(fetcher.mock.calls[0][1].headers.authorization).not.toContain("BROWSER");
});
it("closes only the remote subscriber on consumer cancellation", async () => {
  const cancel = vi.fn(); fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": ping\n\n")); }, cancel }), { headers: sseHeaders }));
  const result = await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events?sessionId=s"), "p");
  const reader = result.body!.getReader(); await reader.read(); await reader.cancel(); expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
});
it("rejects wrong protocol/compression/status and cancels untrusted response bodies", async () => {
  for (const headers of [{ "content-type": "text/event-stream" }, { ...sseHeaders, "content-encoding": "gzip" }, { ...sseHeaders, "x-leafcode-backend-protocol": "2" }]) {
    const cancel = vi.fn(); fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers }));
    expect((await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events?sessionId=s"), "p")).status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
  }
});
it("uses a body-timeout-free dispatcher and does not prefetch an owner frame", async () => {
  vi.useFakeTimers(); const pull = vi.fn(), cancel = vi.fn();
  fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: sseHeaders }));
  const result = await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events?sessionId=s"), "p");
  await vi.advanceTimersByTimeAsync(600000); expect(pull).not.toHaveBeenCalled();
  const options = fetcher.mock.calls[0][1]; expect(options.signal.aborted).toBe(false); expect(options.redirect).toBe("error"); expect(options.headers["accept-encoding"]).toBe("identity");
  expect(mock.agent).toHaveBeenCalledWith(expect.objectContaining({ bodyTimeout: 0, connections: 32 }));
  await result.body!.cancel(); expect(cancel).toHaveBeenCalledOnce(); expect(options.signal.aborted).toBe(true);
});
it("releases an errored upstream reader for EventSource reconnect without leaking its error", async () => {
  const body = new ReadableStream({ pull(c) { c.error(new Error("PRIVATE")); } }, { highWaterMark: 0 });
  fetcher.mockResolvedValueOnce(new Response(body, { headers: sseHeaders }));
  const result = await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events?sessionId=s"), "p");
  await expect(result.body!.getReader().read()).rejects.toThrow("Login event transport closed"); expect(body.locked).toBe(false);
});
it("fails closed without auth/owner availability and never retries or falls back to SDK", async () => {
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); expect((await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events"), "p")).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); fetcher.mockRejectedValueOnce(Error("PRIVATE"));
  const failed = await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events"), "p"); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("PRIVATE"); expect(fetcher).toHaveBeenCalledOnce();
});

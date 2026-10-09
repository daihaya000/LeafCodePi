import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayProviderLoginEvents } from "./provider-auth-events-relay";
const fetcher = vi.fn();
beforeEach(() => {
  for (const [key, value] of Object.entries({ LEAFCODE_PI_WEBUI_AUTH: "", LEAFCODE_PI_WEBUI_TOKEN: "", LEAFCODE_PI_BACKEND_TOKEN: "owner-private-token-1234567890123456789", LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "" })) vi.stubEnv(key, value);
  fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("relays opaque owner SSE/query and strips private owner/browser headers", async () => {
  const bytes = 'event: started\ndata: {"sessionId":"s"}\n\nevent: done\ndata: {"ok":true}\n\n';
  fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "text/event-stream", "set-cookie": "PRIVATE" } }));
  const result = await relayProviderLoginEvents(new Request("http://localhost/api/providers/a%2Fb/login/events?sessionId=s", { headers: { cookie: "BROWSER", authorization: "BROWSER" } }), "a%2Fb");
  expect(await result.text()).toBe(bytes); expect(result.headers.get("set-cookie")).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toContain("/provider-login-events/a%2Fb?sessionId=s");
  expect(fetcher.mock.calls[0][1].headers.cookie).toBeUndefined(); expect(fetcher.mock.calls[0][1].headers.authorization).not.toContain("BROWSER");
});
it("closes only the remote subscriber on consumer cancellation", async () => {
  const cancel = vi.fn(); fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": ping\n\n")); }, cancel }), { headers: { "content-type": "text/event-stream" } }));
  const result = await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events?sessionId=s"), "p");
  const reader = result.body!.getReader(); await reader.read(); await reader.cancel(); expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
});
it("fails closed without auth/owner availability and never retries or falls back to SDK", async () => {
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); expect((await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events"), "p")).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); fetcher.mockRejectedValueOnce(Error("PRIVATE"));
  const failed = await relayProviderLoginEvents(new Request("http://localhost/api/providers/p/login/events"), "p"); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("PRIVATE"); expect(fetcher).toHaveBeenCalledOnce();
});

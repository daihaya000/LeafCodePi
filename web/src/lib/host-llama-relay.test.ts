import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayHostLlama } from "./host-llama-relay";
import { HOST_LLAMA_OPERATION_HEADER } from "@shared/host-llama-contract.mjs";
const fetcher = vi.fn();
const request = (method = "GET", body?: string, headers?: Record<string, string>) => new Request("http://localhost/api/llama-server/models?dir=%2Ffixture", { method, ...(body === undefined ? {} : { body }), headers });
beforeEach(() => { vi.stubEnv("LEAFCODE_PI_HOST_CONTROL_URL", "http://127.0.0.1:19990"); vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", ""); vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("relays models to Host with original query, bounded known projection, no Backend dependency or secret headers", async () => {
  fetcher.mockResolvedValue(Response.json({ dir: "/fixture", models: ["a.gguf"], mmprojs: [], loras: [], defaultModel: null, secret: "PRIVATE" }, { headers: { "set-cookie": "PRIVATE" } }));
  const response = await relayHostLlama(request("GET", undefined, { cookie: "PRIVATE", authorization: "Bearer PRIVATE" }), "models"); expect(response.status).toBe(200);
  expect(await response.json()).not.toHaveProperty("secret"); expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:19990/webui/llama/models?dir=%2Ffixture");
  expect(JSON.stringify(fetcher.mock.calls[0][1].headers)).not.toContain("PRIVATE"); expect(response.headers.has("set-cookie")).toBe(false);
});
it("gates auth, Origin, method and input bytes before effects", async () => {
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); expect((await relayHostLlama(request(), "status")).status).toBe(401); vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
  expect((await relayHostLlama(request("POST", "{}", { origin: "https://outside.invalid" }), "start")).status).toBe(403);
  expect((await relayHostLlama(request(), "start")).status).toBe(405); expect((await relayHostLlama(request("POST", "x".repeat(65537)), "start")).status).toBe(413); expect(fetcher).not.toHaveBeenCalled();
});
it("forwards opaque start input once, checks private ID and never parses settings in Next", async () => {
  const body = '{"effort":"bad","llamaCppPath":"owned-by-Host"}';
  fetcher.mockImplementation((_url, init) => Response.json({ ok: true, operation: { id: new Headers(init.headers).get(HOST_LLAMA_OPERATION_HEADER), execution: "complete" } }));
  const response = await relayHostLlama(request("POST", body), "start"); expect(response.status).toBe(200); expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(body); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("disconnect/failure remains unknown after handoff; old Host returns explicit 501 without local engine fallback", async () => {
  fetcher.mockRejectedValueOnce(new Error("offline")); expect(await (await relayHostLlama(request("POST", "{}"), "stop")).json()).toMatchObject({ execution: "unknown" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "unsupported" }, { status: 404 })); expect((await relayHostLlama(request(), "status")).status).toBe(501); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("malformed/oversized Host results and mismatched mutation receipts fail closed", async () => {
  fetcher.mockResolvedValueOnce(new Response("x".repeat(131073))); expect((await relayHostLlama(request(), "status")).status).toBe(503);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true })); expect((await relayHostLlama(request("POST", "{}"), "ensure-loaded")).status).toBe(503);
});

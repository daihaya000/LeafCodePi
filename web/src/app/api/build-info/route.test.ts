import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_BUILD_OPERATION_HEADER } from "@shared/host-build-info-contract.mjs";
import { GET, POST } from "./route";
const fetcher = vi.fn(), commit = "a".repeat(40), metadata = { commit, committedAt: "2026-10-09T00:00:00Z", latestCommit: commit };
function request(method = "GET", options: RequestInit = {}) { return new Request("http://localhost/api/build-info", { method, ...options }); }
beforeEach(() => {
  vi.stubEnv("LEAFCODE_PI_HOST_CONTROL_URL", "http://127.0.0.1:19991");
  vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", ""); vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
  fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("Host build-info ingress", () => {
  it("reads Host metadata even with no Backend, never follows redirects or forwards secret headers", async () => {
    fetcher.mockResolvedValue(Response.json({ ...metadata, token: "PRIVATE" }, { headers: { "set-cookie": "PRIVATE" } }));
    const response = await GET(request("GET", { headers: { authorization: "Bearer PRIVATE", cookie: "PRIVATE" } }));
    expect(await response.json()).toEqual(metadata); expect(response.headers.has("set-cookie")).toBe(false);
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe("http://127.0.0.1:19991/build-info"); expect(init.redirect).toBe("error");
    expect(JSON.stringify(init.headers)).not.toContain("PRIVATE"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves unavailable nullable metadata without local Git fallback", async () => {
    fetcher.mockResolvedValue(Response.json({ commit: null, committedAt: null, latestCommit: null }, { status: 503 }));
    const response = await GET(request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ commit: null, committedAt: null, latestCommit: null });
  });
  it("gates required auth and cross-origin updates before contacting Host", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); expect((await GET(request())).status).toBe(401);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); expect((await POST(request("POST", { headers: { origin: "https://outside.invalid" } }))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("updates once with a private operation ID and verifies the Host receipt", async () => {
    fetcher.mockImplementation(async (_url, init) => Response.json({ ...metadata, operation: { id: new Headers(init.headers).get(HOST_BUILD_OPERATION_HEADER), execution: "complete", token: "PRIVATE" } }));
    const response = await POST(request("POST")); expect(response.status).toBe(200); const body = await response.json(); expect(body.operation.execution).toBe("complete");
    expect(body.operation).not.toHaveProperty("token"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds request/response bytes, rejects malformed receipts and never retries uncertain updates", async () => {
    expect((await POST(request("POST", { body: "x".repeat(513) }))).status).toBe(413); expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(new Error("offline")); const failed = await POST(request("POST")); expect(await failed.json()).toMatchObject({ execution: "unknown" }); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(Response.json({ ...metadata, operation: { id: "b".repeat(36), execution: "complete" } })); expect((await POST(request("POST"))).status).toBe(503);
    fetcher.mockResolvedValueOnce(new Response("x".repeat(4097))); expect((await GET(request())).status).toBe(503);
  });
  it("reports an older Host without executing a Next Git substitute", async () => {
    fetcher.mockResolvedValue(Response.json({ error: "unsupported" }, { status: 501 }));
    expect((await POST(request("POST"))).status).toBe(501); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

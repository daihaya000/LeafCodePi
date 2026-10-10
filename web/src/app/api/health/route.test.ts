import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const health = { ok: true, engine: "pi", engineOk: true, version: "1.0.0", modelCount: 3, dataDir: "C:\\Users\\PRIVATE\\leafcode-pi", warnings: ["PRIVATE"], startedAt: 10, platform: "win32", token: "PRIVATE" };
const request = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3010/api/health", { headers });
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "fixture-backend-token"); vi.stubEnv("LEAFCODE_PI_BACKEND_URL", "http://127.0.0.1:19999");
  vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION", ""); vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION_FILE", "");
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
  fetcher.mockReset(); fetcher.mockResolvedValue(Response.json({ status: 200, headers: {}, body: health })); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("SDK metadata is Backend-owned; health remains a public edge readiness probe", () => {
  it("returns known private metadata only when browser auth is optional", async () => {
    const body = await (await GET(request())).json(); expect(body.dataDir, JSON.stringify(body) + " calls=" + fetcher.mock.calls.length).toBe(health.dataDir); expect(body.warnings).toEqual(health.warnings);
    expect(body.token).toBeUndefined(); expect(body.startedAt).not.toBe(health.startedAt);
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/json-business/health");
  });
  it("allows the anonymous Host probe but strips paths, warnings and arbitrary fields", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "secret-token");
    const response = await GET(request()); expect(response.status).toBe(200); const body = await response.json();
    expect(body.ok).toBe(true); expect(body).not.toHaveProperty("dataDir"); expect(body).not.toHaveProperty("warnings"); expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });
  it("returns the private projection to Cookie/Bearer callers, never forwards those credentials to Backend", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "secret-token");
    for (const headers of [{ cookie: "leafcode-pi-token=secret-token" }, { authorization: "Bearer secret-token" }]) {
      fetcher.mockResolvedValueOnce(Response.json({ status: 200, headers: {}, body: health }));
      expect((await (await GET(request(headers))).json()).dataDir).toBe(health.dataDir);
    }
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("secret-token");
  });
  it("a stalled Backend cannot hold the Host readiness probe beyond its bounded deadline", async () => {
    vi.useFakeTimers(); fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("stalled")), { once: true })));
    const pending = GET(request()); await vi.advanceTimersByTimeAsync(1001);
    const response = await pending; expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ backendAvailable: false }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps Next ready with explicit unavailable metadata when Backend is absent; no local SDK snapshot", async () => {
    vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", ""); const response = await GET(request()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, engineOk: false, version: null, modelCount: 0, backendAvailable: false }); expect(fetcher).not.toHaveBeenCalled();
  });
});

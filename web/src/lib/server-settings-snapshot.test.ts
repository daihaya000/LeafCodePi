import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readServerSettingsSnapshot } from "./server-settings-snapshot";
const fetcher = vi.fn(); const req = (headers: Record<string, string> = {}) => new Request("http://localhost/", { headers });
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); vi.stubEnv("LEAFCODE_PI_BACKEND_URL", "http://127.0.0.1:19999"); vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "fixture-private"); vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION", ""); vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION_FILE", ""); vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "fixture-browser"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("SSR reads only the authenticated owner's settings", () => {
  it("refuses anonymous SSR before HTTP and returns pending hydration, not local values", async () => { expect(await readServerSettingsSnapshot(req())).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled(); });
  it("forwards only internal credentials and known context, not Cookie/Bearer, origin or arbitrary headers", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ values: { "default-model": "provider::model", missing: null }, token: "must-not-forward" }));
    const result = await readServerSettingsSnapshot(req({ cookie: "leafcode-pi-token=fixture-browser", "x-secret": "must-not-forward" })); expect(result).toEqual({ "default-model": "provider::model", missing: null }); expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/configuration/settings"); const init = fetcher.mock.calls[0][1]; expect(init.redirect).toBe("error"); expect(JSON.stringify(init.headers)).not.toMatch(/fixture-browser|must-not-forward/); expect(init.headers.authorization).toBe("Bearer fixture-private");
  });
  it("rejects HTTP errors, invalid DTO and prototype keys without fallback or retry", async () => {
    for (const response of [Response.json({}, { status: 503 }), Response.json({ values: [] }), Response.json({ values: { bad: 42 } }), Response.json(JSON.parse('{"values":{"__proto__":"bad"}}'))]) {
      fetcher.mockResolvedValueOnce(response); expect(await readServerSettingsSnapshot(req({ authorization: "Bearer fixture-browser" }))).toBeUndefined();
    } expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("refuses stale generation before requesting settings", async () => {
    vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION", "expected"); fetcher.mockResolvedValueOnce(Response.json({ service: "leafcode-pi-backend", protocolVersion: 1, ready: true, runtimeGeneration: "stale" }));
    expect(await readServerSettingsSnapshot(req({ authorization: "Bearer fixture-browser" }))).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toMatch(/\/health$/);
  });
  it("bounds response bytes and cancels the reader", async () => { let canceled = false; fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { canceled = true; } }))); expect(await readServerSettingsSnapshot(req({ authorization: "Bearer fixture-browser" }))).toBeUndefined(); expect(canceled).toBe(true); });
  it("bounds stalled Backend work by deadline without retry", async () => {
    vi.useFakeTimers(); fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Error("stalled")))));
    const result = readServerSettingsSnapshot(req({ authorization: "Bearer fixture-browser" })); await vi.advanceTimersByTimeAsync(1501); expect(await result).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

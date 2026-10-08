import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayJsonBusiness } from "./json-business-relay";
let root: string;
const fetcher = vi.fn();
const request = (route = "git/init", body = '{"directory":"repo"}') => new Request(`http://localhost/api/${route}`, { method: "POST", body });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-json-ingress-"));
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_WEBUI_AUTH: "",
    LEAFCODE_PI_WEBUI_TOKEN: "", LEAFCODE_PI_BACKEND_TOKEN: "owner-private-token-1234567890123456789", LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "" })) vi.stubEnv(key, value);
  fetcher.mockReset().mockImplementation(async () => Response.json({ status: 200, body: { ok: true, directory: "repo", token: "PRIVATE" }, headers: { "set-cookie": "PRIVATE" } }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("JSON business ingress", () => {
  it("relays bytes verbatim without local business validation, persistence or private fields", async () => {
    const response = await relayJsonBusiness(request("git/init", "not valid JSON"), "git/init");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, directory: "repo" });
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe("not valid JSON");
    expect(response.headers.get("set-cookie")).toBeNull(); expect(readdirSync(root)).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves conditional GET and structured partial success", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 304, body: null, headers: { etag: 'W/"etag"', "cache-control": "private, no-cache" } }));
    const response = await relayJsonBusiness(new Request("http://localhost/api/git/log?directory=repo", { headers: { "if-none-match": 'W/"etag"' } }), "git/log");
    expect(response.status).toBe(304); expect(await response.text()).toBe(""); expect(response.headers.get("etag")).toBe('W/"etag"'); expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("if-none-match")).toBe('W/"etag"');
    fetcher.mockResolvedValueOnce(Response.json({ status: 500, body: { error: "restore failed", mergeSucceeded: true, strandedOn: "main", restored: null }, headers: {} }));
    const merge = await relayJsonBusiness(request("git/merge"), "git/merge");
    expect(merge.status).toBe(500); expect(await merge.json()).toMatchObject({ mergeSucceeded: true, strandedOn: "main", restored: null });
  });
  it("lost or malformed owner responses are unknown and never retried", async () => {
    fetcher.mockRejectedValueOnce(new Error("PRIVATE ERROR"));
    const lost = await relayJsonBusiness(request(), "git/init");
    expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ execution: "unknown" }); expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { secret: "PRIVATE" } }));
    const malformed = await relayJsonBusiness(request(), "git/init");
    expect((await malformed.json()).execution).toBe("unknown"); expect(readdirSync(root)).toEqual([]);
  });
  it("rejects admission failures without executing business inputs", async () => {
    vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "");
    expect((await relayJsonBusiness(request(), "git/init")).status).toBe(503);
    vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "owner-private-token-1234567890123456789");
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "UI-TOKEN");
    expect((await relayJsonBusiness(request(), "git/init")).status).toBe(401);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    expect((await relayJsonBusiness(new Request("http://localhost/api/git/init", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }), "git/init")).status).toBe(403);
    expect((await relayJsonBusiness(new Request("http://localhost/api/git/init", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }), "git/init")).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never forwards browser credentials and propagates read cancellation", async () => {
    const abort = new AbortController();
    fetcher.mockImplementation(async (_url, options) => {
      const headers = new Headers(options.headers);
      expect(headers.get("cookie")).toBeNull(); expect(headers.get("authorization")).not.toContain("UI-TOKEN");
      return new Promise((_done, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const result = relayJsonBusiness(new Request("http://localhost/api/git/log", { signal: abort.signal, headers: { cookie: "leafcode-pi-token=UI-TOKEN" } }), "git/log");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); abort.abort();
    expect((await result).status).toBe(503); expect(readdirSync(root)).toEqual([]);
  });
});

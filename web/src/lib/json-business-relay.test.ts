import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayJsonBusiness } from "./json-business-relay";
import { NextRequest } from "next/server";
import { POST as saveAccountKey } from "../app/api/accounts/[id]/openrouter-credits/route";
import { POST as consumeResetCredit } from "../app/api/codexbar/reset-credits/route";
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
  it("actual Next consume route verifies execution ACK, not a settings-save claim, and never retries an uncertain response", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, body: { ok: false, code: "nothing_to_reset", message: "safe", creditId: "c", accountId: null, windowsReset: null, token: "PRIVATE", operation: { id, execution: "complete" } } });
    });
    const body = '{"creditId":"c"}'; const response = await consumeResetCredit(new NextRequest("http://localhost/api/codexbar/reset-credits", { method: "POST", body }));
    expect(response.status).toBe(200); const outcome = await response.json(); expect(outcome).toMatchObject({ ok: false, operation: { execution: "complete" } }); expect(outcome.mutation).toBeUndefined(); expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(body); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { ok: true, code: "reset", creditId: "c" } }));
    const lost = await consumeResetCredit(new NextRequest("http://localhost/api/codexbar/reset-credits", { method: "POST", body })); expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("actual Next account route relays opaque credential input, verifies its receipt and never writes locally", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { ok: true, configured: true, managementKey: "PRIVATE", mutation: {
        operationId: id, saved: true, saveStatus: "complete", revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply: "not-required", recovery: "none" } } });
    });
    const input = '{"managementKey":"PRIVATE-CREDENTIAL"}';
    const response = await saveAccountKey(new NextRequest("http://localhost/api/accounts/fixture/openrouter-credits", { method: "POST", body: input }), { params: Promise.resolve({ id: "fixture" }) });
    expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(input);
    expect(fetcher.mock.calls[0][0]).toContain("/accounts/fixture/openrouter-credits"); expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, headers: {}, body: { ok: true, configured: true } }));
    const lost = await saveAccountKey(new NextRequest("http://localhost/api/accounts/fixture/openrouter-credits", { method: "POST", body: input }), { params: Promise.resolve({ id: "fixture" }) });
    expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("acknowledges auth execution without claiming asynchronous credential save and sends input only to the owner", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { sessionId: "session", apiKey: "PRIVATE", operation: { id, execution: "complete" } } });
    });
    const result = await relayJsonBusiness(new Request("http://localhost/api/providers/fixture/login", { method: "POST", body: '{"type":"api_key"}' }), "providers/fixture/login");
    expect(result.status).toBe(200); const body = await result.json(); expect(body).toMatchObject({ sessionId: "session", operation: { execution: "complete" } });
    expect(body.mutation).toBeUndefined(); expect(body.apiKey).toBeUndefined(); expect(fetcher).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe('{"type":"api_key"}'); expect(readdirSync(root)).toEqual([]);
  });
  it("relays provider identifier/query bytes and preserves a saved endpoint's deferred receipt", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { baseUrl: "https://fixture.test/v1", token: "PRIVATE", mutation: {
        operationId: id, saved: true, saveStatus: "complete", revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply: "deferred", recovery: "none" } } });
    });
    const response = await relayJsonBusiness(new Request("http://localhost/api/providers/leafcodecloud/base-url?accountId=account-1", { method: "PUT", body: '{"baseUrl":"https://fixture.test/v1"}' }), "providers/leafcodecloud/base-url");
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mutation: { saved: true, apply: "deferred" } });
    expect(fetcher.mock.calls[0][0]).toContain("/providers/leafcodecloud/base-url?accountId=account-1");
    expect(readdirSync(root)).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves definition save/apply failure and checks the opaque operation acknowledgement", async () => {
    fetcher.mockImplementation(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 503, headers: {}, body: { error: "apply failed", content: "Saved", path: "AGENTS.md", exists: true,
        mutation: { operationId: id, saved: true, saveStatus: "complete", revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply: "failed", recovery: "none", token: "PRIVATE" } } });
    });
    const result = await relayJsonBusiness(new Request("http://localhost/api/agents-md", { method: "PATCH", body: '{"content":"Saved"}' }), "agents-md");
    expect(result.status).toBe(503); const body = await result.json();
    expect(body.mutation).toMatchObject({ saved: true, apply: "failed" }); expect(body.mutation.token).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { content: "Saved", path: "AGENTS.md", exists: true } }));
    const lost = await relayJsonBusiness(new Request("http://localhost/api/agents-md", { method: "PATCH", body: "{}" }), "agents-md");
    expect(lost.status).toBe(503); expect((await lost.json()).execution).toBe("unknown");
  });
  it("relays dynamic identifiers without decoding business names and gates prompt transfers", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { draft: { name: "nested/name", systemPrompt: "Prompt", secret: "PRIVATE" }, filePath: "agent.md" }, headers: {} }));
    const draft = await relayJsonBusiness(new Request("http://localhost/api/agents/nested%2Fname"), "agents/nested%2Fname");
    expect(draft.status).toBe(200); expect((await draft.json()).draft.secret).toBeUndefined();
    expect(fetcher.mock.calls[0][0]).toContain("/agents/nested%2Fname");
    vi.stubEnv("LEAFCODE_PI_BIND_HOST", "0.0.0.0");
    expect((await relayJsonBusiness(request("prompts/transfer"), "prompts/transfer")).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
  });
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

import { describe, expect, it, vi } from "vitest";
import { createMcpPresetOnBackend, readMcpAuthStatusOnBackend, saveMcpBearerAuthOnBackend, saveMcpHeadersAuthOnBackend, removeMcpBearerAuthOnBackend, removeMcpAuthOnBackend, startMcpOAuthAuthOnBackend, setMcpServerEnabledOnBackend } from "./backend-client";
const env = { LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40), LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:19999" };
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
describe("MCP Backend ON/OFF client", () => {
  it("encodes one server segment and sends only enabled with private authentication", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { ok: true, name: "server name", enabled: false, servers: [] }));
    const result = await setMcpServerEnabledOnBackend("server name", false, { env, fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name");
    const options = fetchImpl.mock.calls[0][1]!;
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body as string)).toEqual({ enabled: false });
    expect(options.headers).toMatchObject({ authorization: `Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`, "x-leafcode-backend-protocol": "1" });
  });
  it("reads auth status using an encoded name and no request credential payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    await readMcpAuthStatusOnBackend("server name", { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
  });
  it("sends bearer save credentials only as a private authenticated POST body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    const input = { type: "bearer" as const, token: "private-fixture-token" };
    await saveMcpBearerAuthOnBackend("server name", input, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    const options = fetchImpl.mock.calls[0][1]!;
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual(input);
    expect(options.headers).toMatchObject({ authorization: `Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}` });
    expect(await saveMcpBearerAuthOnBackend("server", input, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("sends header credentials only in the authenticated owner's POST body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    const input = { type: "headers" as const, headers: { "X-Key": "private-fixture-secret" } };
    await saveMcpHeadersAuthOnBackend("server name", input, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual(input);
    expect(await saveMcpHeadersAuthOnBackend("server", input, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("forwards bearer DELETE without credential/path fields and retains owner-resolved defaults", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    await removeMcpBearerAuthOnBackend("server name", { type: "bearer" }, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("DELETE");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ type: "bearer" });
    await removeMcpBearerAuthOnBackend("server", {}, { env, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[1][1]?.body as string)).toEqual({});
    expect(await removeMcpBearerAuthOnBackend("server", {}, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("forwards header/default DELETE only to the authenticated owner", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    for (const input of [{ type: "headers" as const }, {}]) await removeMcpAuthOnBackend("server name", input, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("DELETE");
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ type: "headers" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1]?.body as string)).toEqual({});
    expect(await removeMcpAuthOnBackend("server", {}, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("forwards OAuth removal without client credentials, callbacks or local fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    await removeMcpAuthOnBackend("server name", { type: "oauth" }, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("DELETE");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ type: "oauth" });
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`);
    expect(await removeMcpAuthOnBackend("server", { type: "oauth" }, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("forwards OAuth start only to the authenticated owner with no callback or credential fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    const input = { type: "oauth" as const, action: "start" as const };
    await startMcpOAuthAuthOnBackend("server name", input, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name/auth");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual(input);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`);
    expect(await startMcpOAuthAuthOnBackend("server", input, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("forwards a preset and its credentials only to the owner", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { ok: true, name: "google-workspace", servers: [],
      reload: { reloaded: 0, deferred: 0, failed: 0, errors: [] } }));
    const input = { preset: "google-workspace" as const, clientId: "fixture-client", clientSecret: "private-fixture-secret" };
    expect((await createMcpPresetOnBackend(input, { env, fetchImpl })).ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual(input);
  });
  it("makes no request without Backend credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await setMcpServerEnabledOnBackend("server", true, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([404, 409, 503])("preserves an owner refusal %i without disclosing raw errors", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(status, { error: "private-fixture-token", code: "BACKEND_BAD_REQUEST" }));
    const result = await setMcpServerEnabledOnBackend("server", true, { env, fetchImpl });
    expect(result).toEqual({ ok: false, reason: "bad-response", status });
  });
});

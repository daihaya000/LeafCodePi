import { NextRequest } from "next/server";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: 1, deferred: 0, failed: 0, errors: [] as string[] })),
}));
const adapter = vi.hoisted(() => ({
  requestMcpWebUiAuth: vi.fn(),
}));

const owner = vi.hoisted(() => ({ localRuntimeBlocked: vi.fn(), readMcpAuthStatusOnBackend: vi.fn(), saveMcpBearerAuthOnBackend: vi.fn(), saveMcpHeadersAuthOnBackend: vi.fn(), removeMcpAuthOnBackend: vi.fn() }));
vi.mock("@/lib/backend-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backend-client")>(), readMcpAuthStatusOnBackend: owner.readMcpAuthStatusOnBackend,
  saveMcpBearerAuthOnBackend: owner.saveMcpBearerAuthOnBackend,
  saveMcpHeadersAuthOnBackend: owner.saveMcpHeadersAuthOnBackend,
  removeMcpAuthOnBackend: owner.removeMcpAuthOnBackend,
}));
vi.mock("@/lib/pi/runtime-ownership", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/pi/runtime-ownership")>(), localRuntimeBlocked: owner.localRuntimeBlocked,
}));
vi.mock("@/lib/pi/harness", () => harness);
vi.mock("@/lib/pi/mcp-webui-bridge", () => adapter);

import { DELETE, GET, POST } from "./route";
import * as mcpLibrary from "@/lib/mcp";

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/mcp/n8n/auth", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ name: "n8n" }) };
}

describe("/api/mcp/:name/auth", () => {
  let agentDir = "";
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-mcp-route-"));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          n8n: {
            url: "https://n8n.example.com/mcp",
            auth: "bearer",
            bearerTokenEnv: "N8N_TOKEN",
          },
        },
      }),
      "utf8",
    );
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    owner.localRuntimeBlocked.mockReturnValue(false);
    owner.readMcpAuthStatusOnBackend.mockReset();
    owner.saveMcpBearerAuthOnBackend.mockReset();
    owner.saveMcpHeadersAuthOnBackend.mockReset();
    owner.removeMcpAuthOnBackend.mockReset();
    adapter.requestMcpWebUiAuth.mockReset();
    adapter.requestMcpWebUiAuth.mockImplementation(async (input: { operation: string }) => {
      if (input.operation === "bearer-status") {
        return { ok: true, operation: "bearer-status", status: "present" };
      }
      if (input.operation === "headers-status") {
        return { ok: true, operation: "headers-status", status: "present" };
      }
      return { ok: true, operation: input.operation };
    });
    harness.reloadLiveSessionsContext.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("saves a bearer token through the adapter without returning or writing it", async () => {
    const token = "secret-bearer-token";
    const response = await POST(request("POST", { type: "bearer", token }), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.auth.credentialStatus).toBe("present");
    expect(JSON.stringify(payload)).not.toContain(token);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.n8n.bearerTokenStore).toBe(true);
    expect(raw.mcpServers.n8n.bearerToken).toBeUndefined();
    expect(raw.mcpServers.n8n.bearerTokenEnv).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({
      operation: "bearer-save",
      serverName: "n8n",
      token,
    });
  });

  it("production bearer POST touches only Backend and whitelists the response", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const localRead = vi.spyOn(mcpLibrary, "getMcpServerAuth");
    const localWrite = vi.spyOn(mcpLibrary, "enableMcpBearerStore");
    const before = readFileSync(join(agentDir, "mcp.json"));
    owner.saveMcpBearerAuthOnBackend.mockResolvedValue({ ok: true, body: { ok: true, token: "private-fixture-token",
      auth: { name: "n8n", authType: "bearer", credentialConfigured: true, credentialSource: "secure-store",
        credentialStatus: "present", configPath: "owner-private-path", credentialMessage: "private-fixture-token" },
      reload: { reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-token"] } } });
    const response = await POST(request("POST", { type: "bearer", token: " private-fixture-token " }), context());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    expect(owner.saveMcpBearerAuthOnBackend).toHaveBeenCalledWith("n8n", { type: "bearer", token: "private-fixture-token" });
    expect(localRead).not.toHaveBeenCalled();
    expect(localWrite).not.toHaveBeenCalled();
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });

  it.each([["not-configured", undefined, 502], ["unreachable", undefined, 502], ["timeout", undefined, 502],
    ["unauthorized", 401, 401], ["bad-response", 404, 404], ["bad-response", 200, 502]])(
    "bearer POST refuses %s/%s without local fallback", async (reason, status, expected) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      const before = readFileSync(join(agentDir, "mcp.json"));
      owner.saveMcpBearerAuthOnBackend.mockResolvedValue({ ok: false, reason, status, error: "private-fixture-token" });
      const response = await POST(request("POST", { token: "private-fixture-token" }), context());
      expect(response.status).toBe(expected);
      expect(JSON.stringify(await response.json())).not.toContain("private-fixture-token");
      expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
      expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
    });

  it("bearer POST rejects invalid fields and malformed owner results before any local action", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    for (const body of [{ token: "" }, { token: "x\ny" }, { token: "x".repeat(8193) },
      { token: "private-fixture-token", configPath: "other" }]) {
      expect((await POST(request("POST", body), context())).status).toBe(400);
    }
    expect(owner.saveMcpBearerAuthOnBackend).not.toHaveBeenCalled();
    for (const body of [{}, { ok: true, auth: { name: "other" }, reload: {} }]) {
      owner.saveMcpBearerAuthOnBackend.mockResolvedValueOnce({ ok: true, body });
      expect((await POST(request("POST", { token: "private-fixture-token" }), context())).status).toBe(502);
    }
    owner.saveMcpBearerAuthOnBackend.mockRejectedValueOnce(new Error("private-fixture-token"));
    const failed = await POST(request("POST", { token: "private-fixture-token" }), context());
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("private-fixture-token");
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });

  it("stores custom headers outside mcp.json", async () => {
    const secret = "secret-header-value";
    const response = await POST(request("POST", {
      type: "headers",
      headers: { "X-API-Key": secret },
    }), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.auth.credentialSource).toBe("secure-store");
    expect(payload.auth.credentialStatus).toBe("present");
    expect(JSON.stringify(payload)).not.toContain(secret);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.n8n.headersStore).toBe(true);
    expect(raw.mcpServers.n8n.auth).toBe(false);
    expect(raw.mcpServers.n8n.headers).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({
      operation: "headers-save",
      serverName: "n8n",
      headers: { "X-API-Key": secret },
    });
  });

  it("production header POST forwards only normalized credentials without touching local state", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const localRead = vi.spyOn(mcpLibrary, "getMcpServerAuth");
    const localWrite = vi.spyOn(mcpLibrary, "enableMcpHeadersStore");
    const before = readFileSync(join(agentDir, "mcp.json"));
    owner.saveMcpHeadersAuthOnBackend.mockResolvedValue({ ok: true, body: { ok: true,
      auth: { name: "n8n", authType: "headers", credentialConfigured: true, credentialSource: "secure-store", credentialStatus: "present",
        configPath: "owner-private-path", credentialMessage: "private-fixture-secret" }, headers: { "X-Key": "private-fixture-secret" },
      reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["private-fixture-secret"] } } });
    const response = await POST(request("POST", { action: "headers", headers: { " X-Key ": " private-fixture-secret " } }), context());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    expect(owner.saveMcpHeadersAuthOnBackend).toHaveBeenCalledWith("n8n", { type: "headers", headers: { "X-Key": "private-fixture-secret" } });
    expect(owner.saveMcpBearerAuthOnBackend).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    expect(localWrite).not.toHaveBeenCalled();
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });

  it.each([["not-configured", undefined, 502], ["unreachable", undefined, 502], ["timeout", undefined, 502],
    ["unauthorized", 401, 401], ["bad-response", 404, 404], ["bad-response", 200, 502]])(
    "header POST refuses %s/%s without local fallback", async (reason, status, expected) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      owner.saveMcpHeadersAuthOnBackend.mockResolvedValue({ ok: false, reason, status, error: "private-fixture-secret" });
      const before = readFileSync(join(agentDir, "mcp.json"));
      const response = await POST(request("POST", { type: "headers", headers: { "X-Key": "private-fixture-secret" } }), context());
      expect(response.status).toBe(expected);
      expect(JSON.stringify(await response.json())).not.toContain("private-fixture-secret");
      expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
      expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
    });

  it("header POST rejects invalid fields, malformed responses and unexpected private errors", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    for (const body of [{ type: "headers", headers: {} }, { type: "headers", headers: { "Bad Header": "private-fixture-secret" } },
      { type: "headers", headers: { "X-Key": "private-fixture-secret" }, configPath: "other" }]) {
      expect((await POST(request("POST", body), context())).status).toBe(400);
    }
    expect(owner.saveMcpHeadersAuthOnBackend).not.toHaveBeenCalled();
    owner.saveMcpHeadersAuthOnBackend.mockResolvedValueOnce({ ok: true, body: {} });
    expect((await POST(request("POST", { type: "headers", headers: { "X-Key": "secret" } }), context())).status).toBe(502);
    owner.saveMcpHeadersAuthOnBackend.mockRejectedValueOnce(new Error("private-fixture-secret"));
    const response = await POST(request("POST", { type: "headers", headers: { "X-Key": "secret" } }), context());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private-fixture-secret");
  });

  it("returns OAuth authorization URLs but never credential material", async () => {
    adapter.requestMcpWebUiAuth.mockResolvedValue({
      ok: true,
      operation: "oauth-start",
      authorizationUrl: "https://id.example.com/authorize?state=public-state",
      status: "pending",
    });
    const response = await POST(request("POST", { type: "oauth", action: "start" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "pending",
      authorizationUrl: "https://id.example.com/authorize?state=public-state",
    });
  });

  it("rejects empty bearer tokens before contacting the adapter", async () => {
    const response = await POST(request("POST", { type: "bearer", token: "   " }), context());
    expect(response.status).toBe(400);
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });

  it("does not reflect secure adapter errors in the API response", async () => {
    const secret = "secret-from-adapter-error";
    adapter.requestMcpWebUiAuth.mockRejectedValueOnce(new Error(secret));
    const response = await POST(request("POST", { type: "bearer", token: "new-token" }), context());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
  });

  it("reads secure-store status without exposing a token", async () => {
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    raw.mcpServers.n8n.bearerTokenStore = true;
    delete raw.mcpServers.n8n.bearerTokenEnv;
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(raw), "utf8");

    const response = await GET(request("GET"), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.credentialSource).toBe("secure-store");
    expect(payload.credentialStatus).toBe("present");
    expect(payload.token).toBeUndefined();
  });

  it.each(["oauth", "auto"])("GET maps %s status without exposing provider messages", async (authType) => {
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    raw.mcpServers.n8n.auth = authType;
    delete raw.mcpServers.n8n.bearerTokenEnv;
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(raw));
    for (const [status, expected] of [["authenticated", "present"], ["expired", "expired"],
      ["not_authenticated", "missing"], ["unavailable", "unavailable"]]) {
      adapter.requestMcpWebUiAuth.mockResolvedValueOnce({ ok: true, operation: "oauth-status", status, message: "private-fixture-secret" });
      const body = await (await GET(request("GET"), context())).json();
      expect(body.credentialStatus).toBe(expected);
      expect(JSON.stringify(body)).not.toContain("private-fixture-secret");
    }
  });

  it("GET maps secure header status without exposing stored headers", async () => {
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    raw.mcpServers.n8n.headersStore = true;
    raw.mcpServers.n8n.auth = false;
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(raw));
    const body = await (await GET(request("GET"), context())).json();
    expect(body.authType).toBe("headers");
    expect(body.credentialStatus).toBe("present");
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "headers-status", serverName: "n8n" });
  });

  it("production GET reads the owner's state without local config or bridge access", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const localRead = vi.spyOn(mcpLibrary, "getMcpServerAuth");
    owner.readMcpAuthStatusOnBackend.mockResolvedValue({ ok: true, body: { name: "n8n", authType: "oauth",
      credentialConfigured: true, credentialSource: "oauth", credentialStatus: "present", configPath: "owner-private-path",
      credentialMessage: "private-fixture-secret", token: "private-fixture-secret" } });
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "n8n", authType: "oauth", credentialConfigured: true,
      credentialSource: "oauth", credentialStatus: "present", configPath: "" });
    expect(owner.readMcpAuthStatusOnBackend).toHaveBeenCalledWith("n8n");
    expect(localRead).not.toHaveBeenCalled();
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });

  it.each([["not-configured", undefined, 502], ["unreachable", undefined, 502], ["timeout", undefined, 502],
    ["unauthorized", 401, 401], ["bad-response", 404, 404]])("GET refuses %s without local fallback", async (reason, status, expected) => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.readMcpAuthStatusOnBackend.mockResolvedValue({ ok: false, reason, status });
    expect((await GET(request("GET"), context())).status).toBe(expected);
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });

  it("GET rejects mismatched responses and redacts local status errors", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.readMcpAuthStatusOnBackend.mockResolvedValue({ ok: true, body: { name: "other" } });
    expect((await GET(request("GET"), context())).status).toBe(502);
    owner.localRuntimeBlocked.mockReturnValue(false);
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    raw.mcpServers.n8n.bearerTokenStore = true;
    delete raw.mcpServers.n8n.bearerTokenEnv;
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(raw));
    adapter.requestMcpWebUiAuth.mockRejectedValueOnce(new Error("private-fixture-secret"));
    const response = await GET(request("GET"), context());
    const body = await response.json();
    expect(body.credentialStatus).toBe("unavailable");
    expect(JSON.stringify(body)).not.toContain("private-fixture-secret");
    adapter.requestMcpWebUiAuth.mockResolvedValueOnce(null);
    expect((await (await GET(request("GET"), context())).json()).credentialStatus).toBe("unavailable");
  });

  it.each([{ type: "bearer" }, { type: "headers" }, { type: "oauth" }, undefined])("production DELETE forwards explicit/default requests without local reads or writes", async (body) => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const localRead = vi.spyOn(mcpLibrary, "getMcpServerAuth");
    const localWrite = vi.spyOn(mcpLibrary, "disableMcpBearerStore");
    const localHeaderWrite = vi.spyOn(mcpLibrary, "disableMcpHeadersStore");
    const before = readFileSync(join(agentDir, "mcp.json"));
    owner.removeMcpAuthOnBackend.mockResolvedValue({ ok: true, body: { ok: true, token: "private-fixture-secret",
      auth: { name: "n8n", authType: "bearer", credentialConfigured: false, credentialSource: "none", credentialStatus: "missing",
        configPath: "owner-private-path", credentialMessage: "private-fixture-secret" },
      reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["private-fixture-secret"] } } });
    const response = await DELETE(request("DELETE", body), context());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    expect(owner.removeMcpAuthOnBackend).toHaveBeenCalledWith("n8n", body ?? {});
    expect(localRead).not.toHaveBeenCalled();
    expect(localWrite).not.toHaveBeenCalled();
    expect(localHeaderWrite).not.toHaveBeenCalled();
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });

  it.each([["not-configured", undefined, 502], ["unreachable", undefined, 502], ["timeout", undefined, 502],
    ["unauthorized", 401, 401], ["bad-response", 404, 404], ["bad-response", 200, 502]])(
    "DELETE refuses %s/%s without fallback", async (reason, status, expected) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      const before = readFileSync(join(agentDir, "mcp.json"));
      owner.removeMcpAuthOnBackend.mockResolvedValue({ ok: false, reason, status, error: "private-fixture-secret" });
      const response = await DELETE(request("DELETE", { type: "bearer" }), context());
      expect(response.status).toBe(expected);
      expect(JSON.stringify(await response.json())).not.toContain("private-fixture-secret");
      expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
      expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
    });

  it("DELETE rejects malformed/privileged/unsupported requests instead of defaulting to a destructive action", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    for (const body of [null, [], { type: "headers", action: "bearer" }, { type: "auto" }, { type: "oauth", input: "private-fixture-secret" }, { type: "bearer", token: "private-fixture-secret" },
      { type: "bearer", configPath: "other" }]) expect((await DELETE(request("DELETE", body), context())).status).toBe(400);
    const malformed = new NextRequest("http://127.0.0.1/api/mcp/n8n/auth", { method: "DELETE", body: "{" });
    expect((await DELETE(malformed, context())).status).toBe(400);
    expect(owner.removeMcpAuthOnBackend).not.toHaveBeenCalled();
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });

  it("DELETE rejects invalid owner responses and redacts unexpected errors", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.removeMcpAuthOnBackend.mockResolvedValueOnce({ ok: true, body: {} });
    expect((await DELETE(request("DELETE"), context())).status).toBe(502);
    owner.removeMcpAuthOnBackend.mockRejectedValueOnce(new Error("private-fixture-secret"));
    const response = await DELETE(request("DELETE"), context());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private-fixture-secret");
  });

  it.each([{ type: "headers" }, undefined])("development DELETE removes owner-selected headers through the guarded helper", async (body) => {
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
      n8n: { url: "https://n8n.example.invalid/mcp", auth: false, headersStore: true, disabled: true },
    } }));
    const response = await DELETE(request("DELETE", body), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.auth.configPath).toBe("");
    expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers.n8n).toEqual({
      url: "https://n8n.example.invalid/mcp", disabled: true,
    });
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "headers-remove", serverName: "n8n" });
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
  });

  it("development DELETE uses guarded OAuth removal and refuses conflicting selectors", async () => {
    const before = readFileSync(join(agentDir, "mcp.json"));
    expect((await DELETE(request("DELETE", { type: "oauth", action: "headers" }), context())).status).toBe(400);
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect((await DELETE(request("DELETE", { type: "oauth" }), context())).status).toBe(200);
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "oauth-remove", serverName: "n8n" });
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });

  it.each(["oauth", "auto"])("development DELETE resolves %s defaults in the owner and returns safe status", async (auth) => {
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
      n8n: { url: "https://n8n.example.invalid/mcp?key=private-url-secret", auth,
        ...(auth === "oauth" ? { oauth: { clientId: "fixture-client", clientSecret: "private-client-secret" } } : {}) },
    } }));
    const before = readFileSync(join(agentDir, "mcp.json"));
    adapter.requestMcpWebUiAuth.mockImplementation(async (input: { operation: string }) => ({
      ok: true, operation: input.operation, ...(input.operation === "oauth-status" ? { status: "not_authenticated", message: "private-fixture-secret" } : {}),
    }));
    const response = await DELETE(request("DELETE"), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.auth.authType).toBe(auth);
    expect(payload.auth.credentialStatus).toBe("missing");
    expect(payload.auth.configPath).toBe("");
    expect(JSON.stringify(payload)).not.toContain("private");
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "oauth-remove", serverName: "n8n" });
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
  });

  it("production OAuth DELETE retains the owner's mode and rejects another server's response", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.removeMcpAuthOnBackend.mockResolvedValueOnce({ ok: true, body: { ok: true,
      auth: { name: "n8n", authType: "oauth", credentialConfigured: false, credentialSource: "oauth", credentialStatus: "missing",
        configPath: "private-owner-path", credentialMessage: "private-token" },
      reload: { reloaded: 0, deferred: 0, failed: 0, errors: [] } } });
    const response = await DELETE(request("DELETE", { action: "oauth" }), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.auth.authType).toBe("oauth");
    expect(JSON.stringify(payload)).not.toContain("private");
    expect(owner.removeMcpAuthOnBackend).toHaveBeenCalledWith("n8n", { type: "oauth" });
    payload.auth.name = "another-server";
    owner.removeMcpAuthOnBackend.mockResolvedValueOnce({ ok: true, body: payload });
    expect((await DELETE(request("DELETE", { type: "oauth" }), context())).status).toBe(502);
    expect(adapter.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });

  it("OAuth DELETE sanitizes post-store reload failures without claiming rollback", async () => {
    const before = readFileSync(join(agentDir, "mcp.json"));
    harness.reloadLiveSessionsContext.mockRejectedValueOnce(new Error("private-reload-secret"));
    const response = await DELETE(request("DELETE", { type: "oauth" }), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private-reload-secret");
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "oauth-remove", serverName: "n8n" });
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });

  it("removes a bearer store reference after the adapter removes the secret", async () => {
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    raw.mcpServers.n8n.bearerTokenStore = true;
    delete raw.mcpServers.n8n.bearerTokenEnv;
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(raw), "utf8");

    const response = await DELETE(request("DELETE", { type: "bearer" }), context());
    expect(response.status).toBe(200);
    const persisted = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(persisted.mcpServers.n8n.bearerTokenStore).toBeUndefined();
    expect(adapter.requestMcpWebUiAuth).toHaveBeenCalledWith({
      operation: "bearer-remove",
      serverName: "n8n",
    });
  });
});

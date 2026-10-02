import { NextRequest } from "next/server";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: 1 })),
}));
const adapter = vi.hoisted(() => ({
  requestMcpWebUiAuth: vi.fn(),
}));

const owner = vi.hoisted(() => ({ localRuntimeBlocked: vi.fn(), readMcpAuthStatusOnBackend: vi.fn() }));
vi.mock("@/lib/backend-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backend-client")>(), readMcpAuthStatusOnBackend: owner.readMcpAuthStatusOnBackend,
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

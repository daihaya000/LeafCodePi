import { NextRequest } from "next/server";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: 1, deferred: 0, failed: 0, errors: [] })),
}));

const owner = vi.hoisted(() => ({ localRuntimeBlocked: vi.fn(), createMcpPresetOnBackend: vi.fn(), readMcpServerListOnBackend: vi.fn() }));
vi.mock("@/lib/pi/harness", () => harness);
vi.mock("@/lib/backend-client", () => ({ createMcpPresetOnBackend: owner.createMcpPresetOnBackend, readMcpServerListOnBackend: owner.readMcpServerListOnBackend }));
vi.mock("@/lib/pi/runtime-ownership", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/pi/runtime-ownership")>(), localRuntimeBlocked: owner.localRuntimeBlocked,
}));

import { GET, POST } from "./route";
import * as mcpLibrary from "@/lib/mcp";
import { createMcpPreset } from "@/lib/mcp-preset-admin";

function request(body?: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/mcp", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/mcp POST", () => {
  let agentDir = "";
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-mcp-route-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    harness.reloadLiveSessionsContext.mockClear();
    owner.localRuntimeBlocked.mockReturnValue(false);
    owner.createMcpPresetOnBackend.mockReset();
    owner.readMcpServerListOnBackend.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("production GET reads only Backend metadata and strips private paths/fields", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const read = vi.spyOn(mcpLibrary, "listMcpServers");
    writeFileSync(join(agentDir, "mcp.json"), "private-invalid-local-json");
    const before = readFileSync(join(agentDir, "mcp.json"));
    owner.readMcpServerListOnBackend.mockResolvedValue({ ok: true, body: { servers: [{ id: "owner-fixture", name: "owner-fixture",
      enabled: false, bundled: true, userConfigured: true, source: "http", authType: "oauth", credentialConfigured: false,
      credentialSource: "oauth", credentialStatus: "unknown", url: "https://private-user:private-password@example.invalid?key=private-key",
      token: "private-token", env: { KEY: "private-env" }, credentialMessage: "private-message" }],
      configPath: "private-path", bundledConfigPath: "private-bundled" } });
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.servers[0].name).toBe("owner-fixture");
    expect(body.configPath).toBe("");
    expect(body.bundledConfigPath).toBeNull();
    expect(JSON.stringify(body)).not.toContain("private");
    expect(owner.readMcpServerListOnBackend).toHaveBeenCalledWith();
    expect(read).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });
  it.each([["not-configured", undefined, 502], ["unreachable", undefined, 502], ["timeout", undefined, 502],
    ["unauthorized", 401, 401], ["incompatible", 409, 409], ["bad-response", 503, 503]])(
    "production GET refuses %s without any local fallback", async (reason, status, expected) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      const read = vi.spyOn(mcpLibrary, "listMcpServers");
      owner.readMcpServerListOnBackend.mockResolvedValue({ ok: false, reason, status, error: "private-token" });
      const response = await GET();
      expect(response.status).toBe(expected);
      expect(JSON.stringify(await response.json())).not.toContain("private-token");
      expect(read).not.toHaveBeenCalled();
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
      expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
    });
  it("production GET rejects malformed success DTOs and private thrown errors", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const read = vi.spyOn(mcpLibrary, "listMcpServers");
    for (const body of [null, {}, { servers: [{ id: "owner-fixture" }] }, { servers: "private-token" }]) {
      owner.readMcpServerListOnBackend.mockResolvedValueOnce({ ok: true, body });
      expect((await GET()).status).toBe(502);
    }
    owner.readMcpServerListOnBackend.mockRejectedValueOnce(new Error("private-token"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private-token");
    expect(read).not.toHaveBeenCalled();
  });
  it("development GET uses the same guarded static owner listing without writes/reload", async () => {
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "private-command", disabled: true } } }));
    const before = readFileSync(join(agentDir, "mcp.json"));
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.servers).toContainEqual(expect.objectContaining({ name: "fixture", enabled: false, source: "stdio" }));
    expect(JSON.stringify(body)).not.toContain("private-command");
    expect(body.configPath).toBe("");
    expect(owner.readMcpServerListOnBackend).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });
  it("development GET keeps malformed config private and unchanged", async () => {
    writeFileSync(join(agentDir, "mcp.json"), "private-invalid-json");
    const before = readFileSync(join(agentDir, "mcp.json"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private-invalid-json");
    expect(readFileSync(join(agentDir, "mcp.json"))).toEqual(before);
  });

  it("adds n8n as an OAuth server and returns the refreshed list", async () => {
    const response = await POST(request({ preset: "n8n", url: "example.app.n8n.cloud" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.servers).toHaveLength(4);
    expect(body.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "n8n", source: "http", authType: "oauth", enabled: true, bundled: true, userConfigured: true }),
    ]));
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledTimes(1);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.n8n).toEqual({
      url: "https://example.app.n8n.cloud/mcp-server/http",
      auth: "oauth",
      httpTransport: "streamable-http",
      protocolVersion: "auto",
    });
  });

  it("adds slack with a pre-registered client ID", async () => {
    const response = await POST(request({ preset: "slack", clientId: "1601185624273.8899143856786" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.servers).toHaveLength(4);
    expect(body.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "slack", authType: "oauth", enabled: true, bundled: true, userConfigured: true }),
    ]));

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.slack.url).toBe("https://mcp.slack.com/mcp");
    expect(raw.mcpServers.slack.oauth.clientId).toBe("1601185624273.8899143856786");
  });

  it("adds the Google Workspace server group", async () => {
    const response = await POST(request({
      preset: "google-workspace",
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret",
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.servers).toHaveLength(12);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers["gws-calendar"].url).toBe("https://calendarmcp.googleapis.com/mcp/v1");
    expect(raw.mcpServers["gws-calendar"].oauth.scope).toContain("calendar.events.readonly");
  });

  it("adds notion", async () => {
    const response = await POST(request({ preset: "notion" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.servers).toHaveLength(4);
    expect(body.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "notion", authType: "oauth", enabled: true, bundled: true, userConfigured: true }),
    ]));

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.notion.url).toBe("https://mcp.notion.com/mcp");
  });

  it("rejects unsupported presets and duplicate registrations", async () => {
    const unsupported = await POST(request({ preset: "other", url: "https://example.com" }));
    expect(unsupported.status).toBe(400);

    await POST(request({ preset: "n8n", url: "example.app.n8n.cloud" }));
    const duplicate = await POST(request({ preset: "n8n", url: "example.app.n8n.cloud" }));
    expect(duplicate.status).toBe(409);
  });

  it.each([
    { preset: "n8n", url: "example.app.n8n.cloud" }, { preset: "slack", clientId: "example-client" },
    { preset: "google-workspace", clientId: "example-client", clientSecret: "private-fixture-secret" }, { preset: "notion" },
  ])("production forwards preset $preset without local persistence or duplicate reload", async (input) => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.createMcpPresetOnBackend.mockResolvedValue({ ok: true, body: { ok: true, name: input.preset, servers: [],
      reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["private-fixture-secret"] }, configPath: "owner-private-path" } });
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, name: input.preset, servers: [],
      reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["セッションの再読込に失敗しました"] } });
    expect(owner.createMcpPresetOnBackend).toHaveBeenCalledWith(input);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
  });

  it.each([["not-configured", undefined, 502], ["unreachable", undefined, 502], ["timeout", undefined, 502],
    ["unauthorized", 401, 401], ["incompatible", 409, 409], ["bad-response", 409, 409]])(
    "production does not fall back on %s", async (reason, status, expected) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      owner.createMcpPresetOnBackend.mockResolvedValue({ ok: false, reason, status });
      expect((await POST(request({ preset: "notion" }))).status).toBe(expected);
      expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    });

  it("rejects malformed Backend successes and privileged request fields", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.createMcpPresetOnBackend.mockResolvedValue({ ok: true, body: { ok: true, name: "notion", servers: [] } });
    expect((await POST(request({ preset: "notion" }))).status).toBe(502);
    owner.createMcpPresetOnBackend.mockClear();
    for (const input of [{ preset: "notion", configPath: "other" }, { preset: "n8n", url: "example.invalid", command: "run" },
      { preset: "notion", clientSecret: "private-fixture-secret" }]) {
      expect((await POST(request(input))).status).toBe(400);
    }
    expect(owner.createMcpPresetOnBackend).not.toHaveBeenCalled();
    expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
  });

  it("the owner handler itself refuses a production WebUI before any write", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "");
    await expect(createMcpPreset({ preset: "notion" })).rejects.toThrow(/Backend/);
    expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });

  it("rejects invalid request bodies", async () => {
    const notJson = new NextRequest("http://127.0.0.1:3010/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await POST(notJson)).status).toBe(400);
    expect((await POST(request({ preset: "n8n" }))).status).toBe(400);
    expect((await POST(request({ preset: "slack" }))).status).toBe(400);
    expect((await POST(request({ preset: "google-workspace" }))).status).toBe(400);
    expect((await POST(request({ preset: "google-workspace", clientId: "x" }))).status).toBe(400);
  });
});

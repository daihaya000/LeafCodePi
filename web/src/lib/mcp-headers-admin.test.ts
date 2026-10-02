import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ requestMcpWebUiAuth: vi.fn() }));
const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
vi.mock("@/lib/pi/mcp-webui-bridge", () => bridge);
vi.mock("@/lib/pi/harness", () => harness);
import { saveMcpHeadersAuth } from "./mcp-headers-admin";
const input = { type: "headers" as const, headers: { "X-API-Key": "private-fixture-secret" } };
describe("owner-only MCP header save", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const keys = ["PI_CODING_AGENT_DIR", "LEAFCODE_PI_BACKEND_RUNTIME"];
  const write = (entry: Record<string, unknown>) => writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "owner-fixture": entry } }));
  beforeEach(() => {
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), "leafcode-header-owner-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
    vi.stubEnv("NODE_ENV", "test");
    write({ url: "https://fixture.example.invalid/mcp", auth: "bearer", bearerTokenStore: true });
    bridge.requestMcpWebUiAuth.mockReset();
    bridge.requestMcpWebUiAuth.mockImplementation(async (request: { operation: string }) => ({ ok: true, operation: request.operation,
      status: "present", message: "private-fixture-secret" }));
    harness.reloadLiveSessionsContext.mockReset();
    harness.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-secret"] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  it("saves headers only in the owner, clears the bearer selector and reloads before status", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LEAFCODE_PI_BACKEND_RUNTIME = "attach";
    const result = await saveMcpHeadersAuth("owner-fixture", input);
    expect(result.auth.credentialStatus).toBe("present");
    expect(JSON.stringify(result)).not.toContain("private");
    const config = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
    expect(config.mcpServers["owner-fixture"].headersStore).toBe(true);
    expect(config.mcpServers["owner-fixture"].auth).toBe(false);
    expect(config.mcpServers["owner-fixture"].bearerTokenStore).toBeUndefined();
    expect(config.mcpServers["owner-fixture"].headers).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("private-fixture-secret");
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "headers-save", serverName: "owner-fixture", headers: input.headers });
    expect(bridge.requestMcpWebUiAuth.mock.calls.map(([request]) => request.operation)).toEqual(["headers-save", "bearer-remove", "headers-status"]);
    expect(harness.reloadLiveSessionsContext.mock.invocationCallOrder[0]).toBeLessThan(bridge.requestMcpWebUiAuth.mock.invocationCallOrder[2]);
  });
  it("refuses production WebUI before storage or reload", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const before = readFileSync(join(root, "mcp.json"));
    await expect(saveMcpHeadersAuth("owner-fixture", input)).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
  });
  it("refuses invalid headers, missing servers and non-HTTP/unresolved URLs before storage", async () => {
    await expect(saveMcpHeadersAuth("owner-fixture", { ...input, headers: {} })).rejects.toMatchObject({ code: "invalid-auth" });
    await expect(saveMcpHeadersAuth("missing-fixture", input)).rejects.toMatchObject({ code: "not-found" });
    for (const entry of [{ command: "fixture-server" }, { url: "file:///private" }, { url: "!fixture-command" }, { url: "${UNRESOLVED_FIXTURE_URL}" }]) {
      write(entry);
      await expect(saveMcpHeadersAuth("owner-fixture", input)).rejects.toMatchObject({ code: "invalid-auth" });
    }
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });
  it.each([null, { ok: false, operation: "headers-save", error: "private-fixture-secret" }, { ok: true, operation: "bearer-save" }])(
    "refuses unavailable/failed/mismatched storage without selector writes", async (response) => {
      const before = readFileSync(join(root, "mcp.json"));
      bridge.requestMcpWebUiAuth.mockResolvedValueOnce(response);
      await expect(saveMcpHeadersAuth("owner-fixture", input)).rejects.toMatchObject({ code: "auth-unavailable" });
      expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    });
  it("redacts exceptions and does not imply rollback after a later bearer-removal failure", async () => {
    bridge.requestMcpWebUiAuth.mockRejectedValueOnce(new Error("private-fixture-secret"));
    await expect(saveMcpHeadersAuth("owner-fixture", input)).rejects.not.toThrow("private-fixture-secret");
    const before = readFileSync(join(root, "mcp.json"));
    bridge.requestMcpWebUiAuth.mockResolvedValueOnce({ ok: true, operation: "headers-save" }).mockRejectedValueOnce(new Error("private-fixture-secret"));
    await expect(saveMcpHeadersAuth("owner-fixture", input)).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
});

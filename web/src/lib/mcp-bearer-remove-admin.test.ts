import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ requestMcpWebUiAuth: vi.fn() }));
const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
vi.mock("@/lib/pi/mcp-webui-bridge", () => bridge);
vi.mock("@/lib/pi/harness", () => harness);
import { removeMcpBearerAuth } from "./mcp-bearer-remove-admin";
describe("owner-only bearer removal", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const keys = ["PI_CODING_AGENT_DIR", "LEAFCODE_PI_BACKEND_RUNTIME"];
  const write = (entry: Record<string, unknown>) => writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "owner-fixture": entry } }));
  beforeEach(() => {
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), "leafcode-bearer-remove-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
    vi.stubEnv("NODE_ENV", "test");
    write({ url: "https://fixture.example.invalid/mcp", auth: "bearer", bearerTokenStore: true });
    bridge.requestMcpWebUiAuth.mockReset();
    bridge.requestMcpWebUiAuth.mockImplementation(async (request: { operation: string }) => ({ ok: true, operation: request.operation }));
    harness.reloadLiveSessionsContext.mockReset();
    harness.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-secret"] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  it.each([{}, { type: "bearer" as const }])("removes in Backend before disabling the selector and reloading", async (input) => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LEAFCODE_PI_BACKEND_RUNTIME = "attach";
    const result = await removeMcpBearerAuth("owner-fixture", input);
    expect(result.auth.credentialStatus).toBe("missing");
    expect(JSON.stringify(result)).not.toContain("private");
    const config = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
    expect(config.mcpServers["owner-fixture"].bearerTokenStore).toBeUndefined();
    expect(config.mcpServers["owner-fixture"].url).toBe("https://fixture.example.invalid/mcp");
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "bearer-remove", serverName: "owner-fixture" });
    expect(bridge.requestMcpWebUiAuth.mock.invocationCallOrder[0]).toBeLessThan(harness.reloadLiveSessionsContext.mock.invocationCallOrder[0]);
  });
  it("refuses production WebUI ownership before storage/config changes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const before = readFileSync(join(root, "mcp.json"));
    await expect(removeMcpBearerAuth("owner-fixture")).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });
  it("owner defaults never delete header/OAuth credentials and missing/prototype entries cannot remove", async () => {
    for (const entry of [{ url: "https://example.invalid", headersStore: true, auth: false }, { url: "https://example.invalid", auth: "oauth" }]) {
      write(entry);
      await expect(removeMcpBearerAuth("owner-fixture")).rejects.toMatchObject({ code: "invalid-auth" });
    }
    for (const name of ["missing-fixture", "__proto__"]) await expect(removeMcpBearerAuth(name, { type: "bearer" })).rejects.toMatchObject({ code: "not-found" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it.each([null, { ok: false, operation: "bearer-remove", error: "private-fixture-secret" }, { ok: true, operation: "headers-remove" },
    { ok: "true", operation: "bearer-remove" }])(
    "refuses failed/missing/mismatched storage without selector changes", async (response) => {
      const before = readFileSync(join(root, "mcp.json"));
      bridge.requestMcpWebUiAuth.mockResolvedValueOnce(response);
      await expect(removeMcpBearerAuth("owner-fixture")).rejects.toMatchObject({ code: "auth-unavailable" });
      expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    });
  it("redacts store exceptions without claiming successful deletion", async () => {
    bridge.requestMcpWebUiAuth.mockRejectedValueOnce(new Error("private-fixture-secret"));
    await expect(removeMcpBearerAuth("owner-fixture")).rejects.not.toThrow("private-fixture-secret");
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ requestMcpWebUiAuth: vi.fn() }));
const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
vi.mock("@/lib/pi/mcp-webui-bridge", () => bridge);
vi.mock("@/lib/pi/harness", () => harness);
import { saveMcpBearerAuth } from "./mcp-bearer-admin";

const input = { type: "bearer" as const, token: "private-fixture-token" };
describe("owner-only MCP bearer save", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const keys = ["PI_CODING_AGENT_DIR", "NODE_ENV", "LEAFCODE_PI_BACKEND_RUNTIME"];
  function write(entry: Record<string, unknown>) {
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "owner-fixture": entry } }));
  }
  beforeEach(() => {
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), "leafcode-bearer-owner-"));
    process.env.PI_CODING_AGENT_DIR = root;
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
    write({ url: "https://fixture.example.invalid/mcp", auth: "bearer", bearerTokenEnv: "FIXTURE_TOKEN" });
    bridge.requestMcpWebUiAuth.mockReset();
    bridge.requestMcpWebUiAuth.mockImplementation(async (request: { operation: string }) => ({
      ok: true, operation: request.operation, status: "present", message: input.token,
    }));
    harness.reloadLiveSessionsContext.mockReset();
    harness.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 1, deferred: 0, failed: 1, errors: [input.token] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("saves to the owner's bridge, writes only the selector and reloads before status", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LEAFCODE_PI_BACKEND_RUNTIME = "attach";
    const result = await saveMcpBearerAuth("owner-fixture", input);
    expect(result.auth.credentialStatus).toBe("present");
    expect(JSON.stringify(result)).not.toContain("private");
    const config = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
    expect(config.mcpServers["owner-fixture"].bearerTokenStore).toBe(true);
    expect(config.mcpServers["owner-fixture"].bearerTokenEnv).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain(input.token);
    expect(bridge.requestMcpWebUiAuth.mock.calls.map(([request]) => request.operation)).toEqual(["bearer-save", "bearer-status"]);
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "bearer-save", serverName: "owner-fixture", token: input.token });
    expect(harness.reloadLiveSessionsContext.mock.invocationCallOrder[0]).toBeLessThan(bridge.requestMcpWebUiAuth.mock.invocationCallOrder[1]);
  });

  it("removes the old secure header reference only after bearer storage succeeds", async () => {
    write({ url: "https://fixture.example.invalid/mcp", auth: false, headersStore: true });
    await saveMcpBearerAuth("owner-fixture", input);
    expect(bridge.requestMcpWebUiAuth.mock.calls.map(([request]) => request.operation)).toEqual(["bearer-save", "headers-remove", "bearer-status"]);
    const config = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
    expect(config.mcpServers["owner-fixture"].headersStore).toBeUndefined();
  });

  it("refuses a production WebUI owner before any read/write/store/reload", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const before = readFileSync(join(root, "mcp.json"));
    await expect(saveMcpBearerAuth("owner-fixture", input)).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
  });

  it("rejects unknown, non-HTTP and unresolved endpoints or invalid tokens before storage", async () => {
    await expect(saveMcpBearerAuth("missing-fixture", input)).rejects.toMatchObject({ code: "not-found" });
    for (const entry of [{ command: "fixture-server" }, { url: "file:///private" }, { url: "!fixture-command" },
      { url: "${UNRESOLVED_FIXTURE_URL}" }]) {
      write(entry);
      await expect(saveMcpBearerAuth("owner-fixture", input)).rejects.toMatchObject({ code: "invalid-auth" });
    }
    await expect(saveMcpBearerAuth("owner-fixture", { ...input, token: "" })).rejects.toMatchObject({ code: "invalid-auth" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });

  it.each([null, { ok: false, operation: "bearer-save", error: input.token }, { ok: true, operation: "headers-save" }])(
    "refuses missing/failed/mismatched store responses without selector writes", async (response) => {
      const before = readFileSync(join(root, "mcp.json"));
      bridge.requestMcpWebUiAuth.mockResolvedValueOnce(response);
      await expect(saveMcpBearerAuth("owner-fixture", input)).rejects.toMatchObject({ code: "auth-unavailable" });
      expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    });

  it("redacts store exceptions and does not claim rollback after a later header-removal failure", async () => {
    bridge.requestMcpWebUiAuth.mockRejectedValueOnce(new Error(input.token));
    await expect(saveMcpBearerAuth("owner-fixture", input)).rejects.not.toThrow(input.token);
    write({ url: "https://fixture.example.invalid/mcp", auth: false, headersStore: true });
    const before = readFileSync(join(root, "mcp.json"));
    bridge.requestMcpWebUiAuth.mockResolvedValueOnce({ ok: true, operation: "bearer-save" }).mockRejectedValueOnce(new Error(input.token));
    await expect(saveMcpBearerAuth("owner-fixture", input)).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ requestMcpWebUiAuth: vi.fn() }));
const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
vi.mock("@/lib/pi/mcp-webui-bridge", () => bridge);
vi.mock("@/lib/pi/harness", () => harness);
import { completeMcpOAuthAuth } from "./mcp-oauth-complete-admin";
const input = { type: "oauth" as const, action: "complete" as const, input: " private-code " };
describe("owner-only OAuth completion", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const keys = ["PI_CODING_AGENT_DIR", "LEAFCODE_PI_BACKEND_RUNTIME", "FIXTURE_OAUTH_URL"];
  const write = (entry: Record<string, unknown>) => writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "owner-fixture": entry } }));
  const bytes = () => readFileSync(join(root, "mcp.json"));
  beforeEach(() => {
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), "leafcode-oauth-complete-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
    delete process.env.FIXTURE_OAUTH_URL;
    vi.stubEnv("NODE_ENV", "test");
    write({ url: "https://fixture.example.invalid/mcp?key=private-url", auth: "oauth",
      oauth: { clientId: "fixture-client", clientSecret: "private-client-secret" } });
    bridge.requestMcpWebUiAuth.mockReset();
    bridge.requestMcpWebUiAuth.mockImplementation(async (request: { operation: string }) => ({
      ok: true, operation: request.operation, status: "authenticated", token: "private-token", message: "private-message",
    }));
    harness.reloadLiveSessionsContext.mockReset();
    harness.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 1, deferred: 0, failed: 1, errors: ["private-reload-error"] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  it.each(["oauth", "auto"])("completes %s in Backend before reload/status without config writes", async (auth) => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LEAFCODE_PI_BACKEND_RUNTIME = "attach";
    if (auth === "auto") write({ url: "https://fixture.example.invalid/mcp" });
    const before = bytes();
    const result = await completeMcpOAuthAuth("owner-fixture", input);
    expect(result.status).toBe("authenticated");
    expect(result.auth.authType).toBe(auth);
    expect(result.auth.credentialStatus).toBe("present");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(bytes()).toEqual(before);
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "oauth-complete", serverName: "owner-fixture", input: "private-code" });
    expect(bridge.requestMcpWebUiAuth.mock.invocationCallOrder[0]).toBeLessThan(harness.reloadLiveSessionsContext.mock.invocationCallOrder[0]);
    expect(harness.reloadLiveSessionsContext.mock.invocationCallOrder[0]).toBeLessThan(bridge.requestMcpWebUiAuth.mock.invocationCallOrder[1]);
  });
  it.each(["expired", "not_authenticated"])("preserves %s results without claiming authentication", async (status) => {
    bridge.requestMcpWebUiAuth.mockImplementation(async (request: { operation: string }) => ({ ok: true, operation: request.operation, status }));
    const result = await completeMcpOAuthAuth("owner-fixture", input);
    expect(result.status).toBe(status);
    expect(result.auth.credentialStatus).toBe(status === "expired" ? "expired" : "missing");
  });
  it("refuses production WebUI before reading credentials or config", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(completeMcpOAuthAuth("owner-fixture", input)).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });
  it("validates inputs/server identity/URL/auth mode before sending the private code", async () => {
    await expect(completeMcpOAuthAuth("owner-fixture", { ...input, configPath: "private" } as never)).rejects.toMatchObject({ code: "invalid-auth" });
    for (const name of ["missing-fixture", "__proto__"]) await expect(completeMcpOAuthAuth(name, input)).rejects.toMatchObject({ code: "not-found" });
    for (const entry of [{ command: "fixture" }, { url: "!private-command", auth: "oauth" }, { url: "${FIXTURE_OAUTH_URL}", auth: "oauth" },
      { url: "https://example.invalid", auth: "bearer", bearerTokenStore: true }, { url: "https://example.invalid", auth: false, headersStore: true }]) {
      write(entry);
      await expect(completeMcpOAuthAuth("owner-fixture", input)).rejects.toMatchObject({ code: "invalid-auth" });
    }
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it.each([null, { ok: false, operation: "oauth-complete", error: "private-code" }, { ok: true, operation: "oauth-start", status: "authenticated" },
    { ok: "true", operation: "oauth-complete", status: "authenticated" }, { ok: true, operation: "oauth-complete", status: "pending" }])(
    "refuses missing, failed, mismatched or invalid completion results before reload", async (response) => {
      const before = bytes();
      bridge.requestMcpWebUiAuth.mockResolvedValueOnce(response);
      await expect(completeMcpOAuthAuth("owner-fixture", input)).rejects.toMatchObject({ code: "auth-unavailable" });
      expect(bytes()).toEqual(before);
      expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
    });
  it("sanitizes provider/code errors without claiming successful completion", async () => {
    bridge.requestMcpWebUiAuth.mockRejectedValueOnce(new Error("private-code"));
    await expect(completeMcpOAuthAuth("owner-fixture", input)).rejects.not.toThrow("private-code");
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it("does not claim consumed-flow/token rollback after a post-completion reload failure", async () => {
    const before = bytes();
    harness.reloadLiveSessionsContext.mockRejectedValueOnce(new Error("private-reload-error"));
    await expect(completeMcpOAuthAuth("owner-fixture", input)).rejects.toThrow("private-reload-error");
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledOnce();
    expect(bytes()).toEqual(before);
  });
});

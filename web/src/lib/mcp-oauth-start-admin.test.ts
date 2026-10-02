import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ requestMcpWebUiAuth: vi.fn() }));
const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
vi.mock("@/lib/pi/mcp-webui-bridge", () => bridge);
vi.mock("@/lib/pi/harness", () => harness);
import { startMcpOAuthAuth } from "./mcp-oauth-start-admin";
const input = { type: "oauth" as const, action: "start" as const };
const authorizationUrl = "https://id.example.invalid/authorize?state=public-state&code_challenge=public-challenge";

describe("owner-only OAuth start", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const keys = ["PI_CODING_AGENT_DIR", "LEAFCODE_PI_BACKEND_RUNTIME", "FIXTURE_OAUTH_URL"];
  const write = (entry: Record<string, unknown>) => writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "owner-fixture": entry } }));
  const bytes = () => readFileSync(join(root, "mcp.json"));
  beforeEach(() => {
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), "leafcode-oauth-start-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
    delete process.env.FIXTURE_OAUTH_URL;
    vi.stubEnv("NODE_ENV", "test");
    write({ url: "https://fixture.example.invalid/mcp", auth: "oauth", disabled: true,
      oauth: { clientId: "fixture-client", clientSecret: "private-client-secret" } });
    bridge.requestMcpWebUiAuth.mockReset();
    bridge.requestMcpWebUiAuth.mockResolvedValue({ ok: true, operation: "oauth-start", status: "pending", authorizationUrl, token: "private-token" });
    harness.reloadLiveSessionsContext.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  it.each(["oauth", "auto"])("starts %s only in Backend without changing config or reloading", async (auth) => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LEAFCODE_PI_BACKEND_RUNTIME = "attach";
    if (auth === "auto") write({ url: "https://fixture.example.invalid/mcp" });
    const before = bytes();
    expect(await startMcpOAuthAuth("owner-fixture", input)).toEqual({ ok: true, name: "owner-fixture", status: "pending", authorizationUrl });
    expect(bytes()).toEqual(before);
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "oauth-start", serverName: "owner-fixture" });
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it("accepts an already authenticated result without an authorization URL", async () => {
    bridge.requestMcpWebUiAuth.mockResolvedValueOnce({ ok: true, operation: "oauth-start", status: "authenticated" });
    expect(await startMcpOAuthAuth("owner-fixture", input)).toEqual({ ok: true, name: "owner-fixture", status: "authenticated" });
  });
  it("refuses production WebUI before credentials/config access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(startMcpOAuthAuth("owner-fixture", input)).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });
  it("refuses malformed inputs, missing/prototype servers and unsupported endpoints before bridge calls", async () => {
    await expect(startMcpOAuthAuth("owner-fixture", { ...input, token: "private-token" } as never)).rejects.toMatchObject({ code: "invalid-auth" });
    for (const name of ["missing-fixture", "__proto__"]) await expect(startMcpOAuthAuth(name, input)).rejects.toMatchObject({ code: "not-found" });
    for (const entry of [{ command: "fixture" }, { url: "!private-command", auth: "oauth" }, { url: "file:///private", auth: "oauth" },
      { url: "${FIXTURE_OAUTH_URL}", auth: "oauth" }, { url: "https://example.invalid", auth: "bearer", bearerTokenStore: true },
      { url: "https://example.invalid", auth: false, headersStore: true }, { url: "https://example.invalid", oauth: false }]) {
      write(entry);
      await expect(startMcpOAuthAuth("owner-fixture", input)).rejects.toMatchObject({ code: "invalid-auth" });
    }
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });
  it("resolves endpoint variables only inside the owner before starting", async () => {
    process.env.FIXTURE_OAUTH_URL = "https://example.invalid/mcp";
    write({ url: "${FIXTURE_OAUTH_URL}", auth: "oauth" });
    expect((await startMcpOAuthAuth("owner-fixture", input)).status).toBe("pending");
  });
  it.each([null, { ok: false, operation: "oauth-start", error: "private-token" }, { ok: true, operation: "oauth-remove" },
    { ok: "true", operation: "oauth-start" }, { ok: true, operation: "oauth-start", status: "pending", authorizationUrl: "javascript:alert(1)" },
    { ok: true, operation: "oauth-start", status: "unknown" }])("refuses missing, failed, mismatched or unsafe provider responses", async (response) => {
    const before = bytes();
    bridge.requestMcpWebUiAuth.mockResolvedValueOnce(response);
    await expect(startMcpOAuthAuth("owner-fixture", input)).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(bytes()).toEqual(before);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it("sanitizes bridge exceptions without claiming pending-state rollback", async () => {
    bridge.requestMcpWebUiAuth.mockRejectedValueOnce(new Error("private-oauth-token"));
    await expect(startMcpOAuthAuth("owner-fixture", input)).rejects.not.toThrow("private-oauth-token");
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
});

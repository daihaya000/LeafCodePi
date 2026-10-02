import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ requestMcpWebUiAuth: vi.fn() }));
const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
vi.mock("@/lib/pi/mcp-webui-bridge", () => bridge);
vi.mock("@/lib/pi/harness", () => harness);
import { removeMcpAuth } from "./mcp-auth-remove-admin";
import * as mcp from "./mcp";

describe("owner-resolved header removal", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const keys = ["PI_CODING_AGENT_DIR", "LEAFCODE_PI_BACKEND_RUNTIME"];
  const write = (entry: Record<string, unknown>) => writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "owner-fixture": entry } }));
  const bytes = () => readFileSync(join(root, "mcp.json"));
  const config = () => JSON.parse(bytes().toString("utf8")).mcpServers["owner-fixture"];
  beforeEach(() => {
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), "leafcode-auth-remove-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
    vi.stubEnv("NODE_ENV", "test");
    write({ url: "https://fixture.example.invalid/mcp", headersStore: true, auth: false, disabled: true });
    bridge.requestMcpWebUiAuth.mockReset();
    bridge.requestMcpWebUiAuth.mockImplementation(async (request: { operation: string }) => ({
      ok: true, operation: request.operation, ...(request.operation.endsWith("-status") ? { status: "present" } : {}),
    }));
    harness.reloadLiveSessionsContext.mockReset();
    harness.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-secret"] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  it.each([{}, { type: "headers" as const }])("resolves header defaults in Backend and removes store -> selector -> reload", async (input) => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LEAFCODE_PI_BACKEND_RUNTIME = "attach";
    bridge.requestMcpWebUiAuth.mockImplementationOnce(async () => {
      expect(config().headersStore).toBe(true);
      return { ok: true, operation: "headers-remove" };
    });
    harness.reloadLiveSessionsContext.mockImplementationOnce(async () => {
      expect(config().headersStore).toBeUndefined();
      return { reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-secret"] };
    });
    const result = await removeMcpAuth("owner-fixture", input);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.auth.configPath).toBe("");
    expect(config()).toEqual({ url: "https://fixture.example.invalid/mcp", disabled: true });
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "headers-remove", serverName: "owner-fixture" });
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
  });
  it("refuses production WebUI before store/config access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const before = bytes();
    await expect(removeMcpAuth("owner-fixture")).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    expect(bytes()).toEqual(before);
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
  });
  it("preserves explicit bearer deletion and owner-selected bearer/none defaults", async () => {
    for (const entry of [{ url: "https://example.invalid", auth: "bearer", bearerTokenStore: true }, { url: "https://example.invalid", auth: false }]) {
      write(entry);
      await removeMcpAuth("owner-fixture");
      expect(config().bearerTokenStore).toBeUndefined();
      expect(bridge.requestMcpWebUiAuth).toHaveBeenLastCalledWith({ operation: "bearer-remove", serverName: "owner-fixture" });
    }
  });
  it("explicit headers delete only headers when bearer is selected", async () => {
    write({ url: "https://example.invalid", auth: "bearer", bearerTokenStore: true, bearerTokenEnv: "FIXTURE_TOKEN" });
    const before = bytes();
    await removeMcpAuth("owner-fixture", { type: "headers" });
    expect(bytes()).toEqual(before);
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "headers-remove", serverName: "owner-fixture" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalledWith({ operation: "bearer-remove", serverName: "owner-fixture" });
  });
  it("explicit bearer removes only bearer credentials when headers are selected", async () => {
    const before = bytes();
    const result = await removeMcpAuth("owner-fixture", { type: "bearer" });
    expect(bytes()).toEqual(before);
    expect(result.auth.authType).toBe("headers");
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledWith({ operation: "bearer-remove", serverName: "owner-fixture" });
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalledWith({ operation: "headers-remove", serverName: "owner-fixture" });
  });
  it("retains literal header references rather than deleting configuration secrets", async () => {
    write({ url: "https://example.invalid", headersStore: true, auth: false, headers: { "x-static": "private-config-value" } });
    const result = await removeMcpAuth("owner-fixture");
    expect(config().headers).toEqual({ "x-static": "private-config-value" });
    expect(JSON.stringify(result)).not.toContain("private-config-value");
  });
  it("refuses unknown/prototype names, invalid inputs and OAuth/auto defaults before storage", async () => {
    for (const name of ["missing-fixture", "__proto__"]) await expect(removeMcpAuth(name)).rejects.toMatchObject({ code: "not-found" });
    await expect(removeMcpAuth("owner-fixture", { type: "oauth" } as never)).rejects.toMatchObject({ code: "invalid-auth" });
    for (const auth of ["oauth", "auto"]) {
      write({ url: "https://example.invalid", auth });
      await expect(removeMcpAuth("owner-fixture")).rejects.toMatchObject({ code: "invalid-auth" });
    }
    expect(bridge.requestMcpWebUiAuth).not.toHaveBeenCalled();
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it.each([null, { ok: false, operation: "headers-remove", error: "private-fixture-secret" },
    { ok: true, operation: "bearer-remove" }, { ok: "true", operation: "headers-remove" }])("refuses storage failures without changing selectors", async (response) => {
    const before = bytes();
    bridge.requestMcpWebUiAuth.mockResolvedValueOnce(response);
    await expect(removeMcpAuth("owner-fixture")).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(bytes()).toEqual(before);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it("sanitizes credential-store exceptions", async () => {
    bridge.requestMcpWebUiAuth.mockRejectedValueOnce(new Error("private-fixture-secret"));
    await expect(removeMcpAuth("owner-fixture")).rejects.not.toThrow("private-fixture-secret");
    expect(config().headersStore).toBe(true);
  });
  it("does not claim rollback or reload after a post-store config failure", async () => {
    vi.spyOn(mcp, "disableMcpHeadersStore").mockImplementationOnce(() => { throw new Error("private-config-failure"); });
    await expect(removeMcpAuth("owner-fixture")).rejects.toThrow("private-config-failure");
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledOnce();
    expect(config().headersStore).toBe(true);
    expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
  it("does not claim rollback after a post-config reload failure", async () => {
    harness.reloadLiveSessionsContext.mockRejectedValueOnce(new Error("private-reload-failure"));
    await expect(removeMcpAuth("owner-fixture")).rejects.toThrow("private-reload-failure");
    expect(config().headersStore).toBeUndefined();
    expect(bridge.requestMcpWebUiAuth).toHaveBeenCalledOnce();
  });
});

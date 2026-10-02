import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMcpServerList } from "./mcp-list-admin";

describe("owner-only static MCP list", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-mcp-list-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "");
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {
      "private-stdio-fixture": { command: "!private-command", args: ["private-arg"], env: { TOKEN: "private-token" }, disabled: true },
      "http-fixture": { url: "https://private-user:private-password@example.invalid/mcp?key=private-key#private-fragment", auth: "oauth",
        oauth: { clientSecret: "private-secret" } },
      "template-fixture": { url: "${PRIVATE_MISSING_URL}", auth: "bearer", bearerTokenStore: true },
      notion: { disabled: true },
    } }));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
  it.each(["development", "backend"])("reads merged metadata in %s without writes, connections or command execution", (host) => {
    if (host === "backend") { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach"); }
    const before = readFileSync(join(root, "mcp.json"));
    const files = readdirSync(root);
    const result = readMcpServerList();
    expect(result.configPath).toBe("");
    expect(result.bundledConfigPath).toBeNull();
    expect(result.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "private-stdio-fixture", enabled: false, source: "stdio", bundled: false, userConfigured: true }),
      expect.objectContaining({ name: "http-fixture", source: "http", url: "https://example.invalid/mcp", authType: "oauth" }),
      expect.objectContaining({ name: "template-fixture", authType: "bearer", credentialStatus: "unknown" }),
      expect.objectContaining({ name: "notion", enabled: false, bundled: true, userConfigured: true }),
    ]));
    const stdio = result.servers.find((row) => row.name === "private-stdio-fixture")!;
    expect(stdio).not.toHaveProperty("command");
    expect(stdio).not.toHaveProperty("env");
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.servers.find((row) => row.name === "template-fixture")).not.toHaveProperty("url");
    expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
    expect(readdirSync(root)).toEqual(files);
  });
  it("refuses production WebUI before any configuration read", () => {
    vi.stubEnv("NODE_ENV", "production");
    writeFileSync(join(root, "mcp.json"), "private-invalid-json");
    expect(() => readMcpServerList()).toThrow(expect.objectContaining({ code: "RUNTIME_NOT_OWNED" }));
  });
  it.each(["private-invalid-json", "null", "[]", '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":{"fixture":null}}'])(
    "rejects malformed config without raw errors/logging/writes: %s", (text) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        writeFileSync(join(root, "mcp.json"), text);
        const before = readFileSync(join(root, "mcp.json"));
        expect(() => readMcpServerList()).toThrow("MCP configuration unavailable");
        expect(warn).not.toHaveBeenCalled();
        expect(readFileSync(join(root, "mcp.json"))).toEqual(before);
        expect(readdirSync(root)).toEqual(["mcp.json"]);
      } finally { warn.mockRestore(); }
    });
  it("retains prototype-like configured identities as own metadata, never inherited entries", () => {
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries([
      ["__proto__", { command: "fixture" }], ["constructor", { command: "fixture" }],
    ]) }));
    const names = readMcpServerList().servers.map((row) => row.name);
    expect(names).toContain("__proto__");
    expect(names).toContain("constructor");
    expect(names).not.toContain("toString");
  });
});

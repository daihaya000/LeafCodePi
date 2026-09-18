import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  addN8nServer,
  disableMcpHeadersStore,
  enableMcpBearerStore,
  enableMcpHeadersStore,
  getMcpServerAuth,
  listMcpServers,
  mcpErrorStatus,
  normalizeN8nServerUrl,
  piMcpConfigPath,
  resolveMcpServerUrl,
  setMcpServerEnabled,
  McpError,
} from "./mcp";

describe("piMcpConfigPath", () => {
  it("lives in the Pi agent dir", () => {
    assert.equal(piMcpConfigPath(join("C:", "pi", "agent")), join("C:", "pi", "agent", "mcp.json"));
  });
});

describe("listMcpServers / setMcpServerEnabled", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  function fixture() {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-mcp-agent-"));
    const dir = join(agentDir, "git", "github.com", "x", "db");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          chrome_devtools: { command: "npx", args: ["-y", "chrome-devtools-mcp"] },
          remote: { url: "https://example.com/mcp", disabled: true },
          bearer: {
            url: "https://user:password@example.com/mcp?token=secret",
            auth: "bearer",
            bearerToken: "secret-token",
          },
          oauth: { url: "https://oauth.example.com/mcp", auth: "oauth" },
        },
      }),
      "utf8",
    );
    return { agentDir };
  }

  it("lists servers with enabled state", () => {
    fixture();
    const result = listMcpServers(agentDir);
    const byName = new Map(result.servers.map((s) => [s.name, s]));
    assert.equal(byName.get("chrome_devtools")?.enabled, true);
    assert.equal(byName.get("chrome_devtools")?.source, "stdio");
    assert.equal(byName.get("remote")?.enabled, false);
    assert.equal(byName.get("remote")?.source, "http");
    assert.equal(result.configPath, join(agentDir, "mcp.json"));
    const bearer = byName.get("bearer");
    assert.equal(bearer?.authType, "bearer");
    assert.equal(bearer?.credentialSource, "config");
    assert.equal(bearer?.credentialStatus, "present");
    assert.equal(bearer?.url, "https://example.com/mcp");
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it("stores only the bearer store switch in mcp.json", () => {
    fixture();
    enableMcpBearerStore("bearer", agentDir);
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(raw.mcpServers.bearer.auth, "bearer");
    assert.equal(raw.mcpServers.bearer.bearerTokenStore, true);
    assert.equal("bearerToken" in raw.mcpServers.bearer, false);
    assert.doesNotMatch(JSON.stringify(raw), /secret-token/);
  });

  it("selects store-backed headers as an explicit non-OAuth mode", () => {
    fixture();
    enableMcpHeadersStore("oauth", agentDir);
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(raw.mcpServers.oauth.headersStore, true);
    assert.equal(raw.mcpServers.oauth.auth, false);
    assert.equal(raw.mcpServers.oauth.oauth, undefined);
    assert.equal(getMcpServerAuth("oauth", agentDir).authType, "headers");

    disableMcpHeadersStore("oauth", agentDir);
    const restored = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(restored.mcpServers.oauth.headersStore, undefined);
    assert.equal(restored.mcpServers.oauth.auth, undefined);
  });

  it("resolves URL environment variables without exposing secrets", () => {
    fixture();
    const previous = process.env.TEST_MCP_URL;
    process.env.TEST_MCP_URL = "https://example.com/mcp";
    try {
      const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
      raw.mcpServers.env_url = { url: "${TEST_MCP_URL}" };
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(raw), "utf8");
      assert.equal(resolveMcpServerUrl("env_url", agentDir), "https://example.com/mcp");
      assert.equal(getMcpServerAuth("oauth", agentDir).authType, "oauth");
    } finally {
      if (previous === undefined) delete process.env.TEST_MCP_URL;
      else process.env.TEST_MCP_URL = previous;
    }
  });

  it("disables and enables a server by writing disabled field", () => {
    fixture();
    setMcpServerEnabled("chrome_devtools", false, agentDir);
    assert.equal(listMcpServers(agentDir).servers.find((s) => s.name === "chrome_devtools")?.enabled, false);
    // persisted literally
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(raw.mcpServers.chrome_devtools.disabled, true);

    setMcpServerEnabled("chrome_devtools", true, agentDir);
    assert.equal(listMcpServers(agentDir).servers.find((s) => s.name === "chrome_devtools")?.enabled, true);
    const raw2 = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal("disabled" in raw2.mcpServers.chrome_devtools, false);
  });

  it("rejects unknown names and leaves existing config intact", () => {
    fixture();
    assert.throws(() => setMcpServerEnabled("missing", false, agentDir), McpError);
    assert.throws(() => setMcpServerEnabled("missing", false, agentDir), /見つかりません/);
    assert.equal(listMcpServers(agentDir).servers.length, 4);
  });

  it("rejects invalid names", () => {
    fixture();
    assert.throws(() => setMcpServerEnabled("a/b", false, agentDir), /名前が不正/);
  });

  it("adds an n8n OAuth entry while keeping existing servers", () => {
    fixture();
    addN8nServer("example.app.n8n.cloud", agentDir);
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.deepEqual(raw.mcpServers.n8n, {
      url: "https://example.app.n8n.cloud/mcp-server/http",
      auth: "oauth",
      httpTransport: "streamable-http",
      protocolVersion: "auto",
    });
    assert.ok(raw.mcpServers.chrome_devtools);
    const listed = listMcpServers(agentDir).servers.find((s) => s.name === "n8n");
    assert.equal(listed?.source, "http");
    assert.equal(listed?.authType, "oauth");
    assert.equal(listed?.enabled, true);
  });

  it("rejects a second n8n registration without touching the file", () => {
    fixture();
    addN8nServer("https://example.app.n8n.cloud/mcp-server/http", agentDir);
    assert.throws(() => addN8nServer("https://other.example.com", agentDir), /既に登録/);
    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(raw.mcpServers.n8n.url, "https://example.app.n8n.cloud/mcp-server/http");
  });
});

describe("normalizeN8nServerUrl", () => {
  it("assumes https and appends the instance MCP endpoint path", () => {
    assert.equal(
      normalizeN8nServerUrl("example.app.n8n.cloud"),
      "https://example.app.n8n.cloud/mcp-server/http",
    );
    assert.equal(
      normalizeN8nServerUrl("https://example.app.n8n.cloud/"),
      "https://example.app.n8n.cloud/mcp-server/http",
    );
    assert.equal(
      normalizeN8nServerUrl("http://localhost:5678"),
      "http://localhost:5678/mcp-server/http",
    );
  });

  it("keeps explicit paths and rejects invalid input", () => {
    assert.equal(
      normalizeN8nServerUrl("https://example.com/n8n/mcp-server/http"),
      "https://example.com/n8n/mcp-server/http",
    );
    assert.throws(() => normalizeN8nServerUrl("ftp://example.com"), /http\(s\)/);
    assert.throws(() => normalizeN8nServerUrl("   "), McpError);
  });
});

describe("mcpErrorStatus", () => {
  it("maps invalid-name to 400 and not-found to 404", () => {
    assert.equal(mcpErrorStatus(new McpError("invalid-name", "x")), 400);
    assert.equal(mcpErrorStatus(new McpError("not-found", "x")), 404);
    assert.equal(mcpErrorStatus(new McpError("conflict", "x")), 409);
    assert.equal(mcpErrorStatus(new Error("boom")), 500);
  });
});

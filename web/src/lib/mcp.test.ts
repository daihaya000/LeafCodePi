import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { listMcpServers, mcpErrorStatus, piMcpConfigPath, setMcpServerEnabled, McpError } from "./mcp";

describe("piMcpConfigPath", () => {
  it("lives in the Pi agent dir", () => {
    assert.equal(piMcpConfigPath("C:\\pi\\agent"), "C:\\pi\\agent\\mcp.json");
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
    assert.equal(listMcpServers(agentDir).servers.length, 2);
  });

  it("rejects invalid names", () => {
    fixture();
    assert.throws(() => setMcpServerEnabled("a/b", false, agentDir), /名前が不正/);
  });
});

describe("mcpErrorStatus", () => {
  it("maps invalid-name to 400 and not-found to 404", () => {
    assert.equal(mcpErrorStatus(new McpError("invalid-name", "x")), 400);
    assert.equal(mcpErrorStatus(new McpError("not-found", "x")), 404);
    assert.equal(mcpErrorStatus(new Error("boom")), 500);
  });
});

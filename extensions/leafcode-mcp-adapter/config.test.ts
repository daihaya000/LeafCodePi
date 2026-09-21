import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { loadMcpConfig } from "./config.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundled MCP config", () => {
  it("loads bundled servers below user overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-mcp-config-"));
    tempDirs.push(dir);
    const overridePath = join(dir, "mcp.json");
    writeFileSync(
      overridePath,
      JSON.stringify({
        mcpServers: {
          notion: { disabled: true },
          custom: { command: "custom-mcp" },
        },
      }),
      "utf8",
    );

    const config = loadMcpConfig(overridePath, dir);

    assert.equal(config.mcpServers["browser-use"]?.command, "browser-use");
    assert.equal(config.mcpServers.notion?.url, "https://mcp.notion.com/mcp");
    assert.equal(config.mcpServers.notion?.disabled, true);
    assert.equal(config.mcpServers.custom?.command, "custom-mcp");
  });
});

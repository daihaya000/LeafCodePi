import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpAdapter } from "./index.ts";

let root: string;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it.each([false, true])("exposes the MCP gateway only when a server is configured: %s", (configured) => {
  root = mkdtempSync(join(tmpdir(), "mcp-visibility-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const tools: string[] = [], commands: string[] = [];
  const api = {
    on: vi.fn(), registerFlag: vi.fn(), getActiveTools: () => [],
    registerTool: ({ name }: { name: string }) => tools.push(name),
    registerCommand: (name: string) => commands.push(name),
  } as unknown as ExtensionAPI;
  createMcpAdapter({ config: { mcpServers: configured ? { example: { url: "http://localhost:1/mcp", lifecycle: "lazy" } } : {} } })(api);
  expect(tools.includes("mcp")).toBe(configured);
  expect(commands).toContain("mcp");
});

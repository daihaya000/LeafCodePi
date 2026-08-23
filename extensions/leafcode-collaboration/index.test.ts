import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import collaborationExtension from "./index";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type Tool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: ExtensionContext) => Promise<{ details?: Record<string, unknown> }>;
};

describe("LeafCode collaboration extension", () => {
  it("joins lazily when an existing session calls status after extension reload", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leafcode-collab-extension-repo-"));
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-extension-data-"));
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, Tool>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    collaborationExtension(pi);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore", windowsHide: true });
    const ctx = {
      cwd: repo,
      hasUI: false,
      sessionManager: {
        getSessionId: () => "existing-session",
        getSessionName: () => "Existing session",
      },
    } as ExtensionContext;

    try {
      process.env.LEAFCODE_PI_DATA_DIR = dataDir;
      const result = await tools.get("leafcode_collab")!.execute("call", { action: "status" }, new AbortController().signal, () => undefined, ctx);
      assert.equal(result.details?.ready, true);
      const snapshot = result.details?.snapshot as { sessions: Record<string, { displayName: string }> };
      assert.equal(snapshot.sessions["existing-session"]?.displayName, "Existing session");
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

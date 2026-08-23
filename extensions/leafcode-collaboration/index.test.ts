import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import collaborationExtension from "./index";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type Tool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: ExtensionContext) => Promise<{ details?: Record<string, unknown> }>;
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

describe("LeafCode collaboration extension", () => {
  it("stays inert when collaboration is off", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leafcode-collab-extension-repo-"));
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-extension-data-"));
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, Tool>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    git(repo, ["init"]);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({ mode: "off" }), "utf8");
    process.env.LEAFCODE_PI_DATA_DIR = dataDir;
    collaborationExtension(pi);
    const ctx = {
      cwd: repo,
      hasUI: false,
      sessionManager: {
        getSessionId: () => "disabled-session",
        getSessionName: () => "Disabled session",
      },
    } as ExtensionContext;

    try {
      await handlers.get("session_start")?.({}, ctx);
      assert.equal(await handlers.get("before_agent_start")?.({}, ctx), undefined);
      assert.equal(await handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx), undefined);
      const status = await tools.get("leafcode_collab")!.execute(
        "status",
        { action: "status" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      assert.equal(status.details?.disabled, true);
      assert.equal(existsSync(join(dataDir, "rooms")), false);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

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
      await assert.rejects(
        tools.get("leafcode_collab")!.execute("call", { action: "recover" }, new AbortController().signal, () => undefined, ctx),
        /Unknown leafcode_collab action 'recover'.*Available actions: status, resync/,
      );
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps one room client when tool calls use fresh ExtensionContext objects", async () => {
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
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    const filePath = join(repo, "src/a.ts");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const a = 1;\n", "utf8");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const sessionManager = {
      getSessionId: () => "stable-session",
      getSessionName: () => "Stable session",
    };
    const ctxStart = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;
    const ctxReserve = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;
    const ctxEdit = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;
    const ctxShutdown = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;

    try {
      process.env.LEAFCODE_PI_DATA_DIR = dataDir;
      await handlers.get("session_start")?.({}, ctxStart);
      const reserved = await tools.get("leafcode_collab")!.execute(
        "reserve",
        { action: "reserve", paths: ["src/a.ts"] },
        new AbortController().signal,
        () => undefined,
        ctxReserve,
      );
      assert.match(String(reserved.details?.lease && (reserved.details.lease as { id?: string }).id), /-/);
      await tools.get("leafcode_edit")!.execute(
        "edit",
        { path: "src/a.ts", oldText: "1", newText: "2" },
        new AbortController().signal,
        () => undefined,
        ctxEdit,
      );
      assert.equal(readFileSync(filePath, "utf8"), "export const a = 2;\n");
    } finally {
      await handlers.get("session_shutdown")?.({}, ctxShutdown);
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resynchronizes the current session without losing its lease", async () => {
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
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    const filePath = join(repo, "src/a.ts");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const a = 1;\n", "utf8");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const sessionManager = {
      getSessionId: () => "resync-session",
      getSessionName: () => "Resync session",
    };
    const ctx = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;

    try {
      process.env.LEAFCODE_PI_DATA_DIR = dataDir;
      await handlers.get("session_start")?.({}, ctx);
      const reserved = await tools.get("leafcode_collab")!.execute(
        "reserve",
        { action: "reserve", paths: ["src/a.ts"] },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      const leaseId = (reserved.details?.lease as { id?: string } | undefined)?.id;

      const resynced = await tools.get("leafcode_collab")!.execute(
        "resync",
        { action: "resync" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      assert.equal(resynced.details?.ready, true);
      assert.equal(resynced.details?.resynchronized, true);
      const snapshot = resynced.details?.snapshot as {
        sessions: Record<string, { state: string }>;
        leases: Record<string, { ownerSessionId: string; state: string }>;
      };
      assert.equal(snapshot.sessions["resync-session"]?.state, "active");
      assert.equal(snapshot.leases[String(leaseId)]?.ownerSessionId, "resync-session");
      assert.equal(snapshot.leases[String(leaseId)]?.state, "active");

      await tools.get("leafcode_edit")!.execute(
        "edit",
        { path: "src/a.ts", oldText: "1", newText: "2" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      assert.equal(readFileSync(filePath, "utf8"), "export const a = 2;\n");
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("shares runtime across trailing-slash and subdirectory cwd values", async () => {
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
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    const filePath = join(repo, "src/a.ts");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const a = 1;\n", "utf8");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const sessionManager = {
      getSessionId: () => "cwd-session",
      getSessionName: () => "Cwd session",
    };
    const ctxStart = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;
    const ctxReserve = { cwd: `${repo}${sep}`, hasUI: false, sessionManager } as ExtensionContext;
    const ctxEdit = { cwd: join(repo, "src"), hasUI: false, sessionManager } as ExtensionContext;
    const ctxShutdown = { cwd: repo, hasUI: false, sessionManager } as ExtensionContext;

    try {
      process.env.LEAFCODE_PI_DATA_DIR = dataDir;
      await handlers.get("session_start")?.({}, ctxStart);
      await tools.get("leafcode_collab")!.execute(
        "reserve",
        { action: "reserve", paths: ["src/a.ts"] },
        new AbortController().signal,
        () => undefined,
        ctxReserve,
      );
      await tools.get("leafcode_edit")!.execute(
        "edit",
        { path: "src/a.ts", oldText: "1", newText: "2" },
        new AbortController().signal,
        () => undefined,
        ctxEdit,
      );
      assert.equal(readFileSync(filePath, "utf8"), "export const a = 2;\n");
    } finally {
      await handlers.get("session_shutdown")?.({}, ctxShutdown);
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

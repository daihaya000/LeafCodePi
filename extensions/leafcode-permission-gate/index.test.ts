import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import permissionGate from "./index";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

describe("LeafCode permission gate", () => {
  it("applies deny to both shell tools and asks before dangerous PowerShell", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-project-"));
    const appDir = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-data-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = appDir;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    permissionGate(pi);

    const sessionManager = {
      getSessionId: () => "permission-test-session",
      getSessionName: () => "Permission test",
    };
    const denyContext = { cwd, hasUI: false, sessionManager } as ExtensionContext;

    try {
      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "deny" }), "utf8");
      await handlers.get("session_start")?.({}, denyContext);
      const bash = await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo ok" } }, denyContext);
      const powershell = await handlers.get("tool_call")?.({ toolName: "powershell", input: { command: "Write-Output ok" } }, denyContext);
      assert.equal((bash as { block?: boolean } | undefined)?.block, true);
      assert.equal((powershell as { block?: boolean } | undefined)?.block, true);

      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "ask" }), "utf8");
      const askContext = {
        cwd,
        hasUI: true,
        sessionManager,
        ui: { select: async () => "No", notify: () => undefined },
      } as unknown as ExtensionContext;
      await handlers.get("session_start")?.({}, askContext);
      const dangerous = await handlers.get("tool_call")?.(
        { toolName: "powershell", input: { command: "Remove-Item -Recurse -Force target" } },
        askContext,
      );
      assert.equal((dangerous as { block?: boolean } | undefined)?.block, true);
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      assert.equal(existsSync(join(cwd, ".pi")), false);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});

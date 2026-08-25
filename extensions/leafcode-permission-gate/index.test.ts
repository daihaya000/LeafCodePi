import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import permissionGate from "./index";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

describe("LeafCode permission gate", () => {
  it("applies deny to both shell tools and asks before dangerous PowerShell", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-"));
    const configDir = join(cwd, ".pi", "leafcode");
    mkdirSync(configDir, { recursive: true });
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
      writeFileSync(join(configDir, "permission-gate.json"), JSON.stringify({ mode: "deny" }), "utf8");
      await handlers.get("session_start")?.({}, denyContext);
      const bash = await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo ok" } }, denyContext);
      const powershell = await handlers.get("tool_call")?.({ toolName: "powershell", input: { command: "Write-Output ok" } }, denyContext);
      assert.equal((bash as { block?: boolean } | undefined)?.block, true);
      assert.equal((powershell as { block?: boolean } | undefined)?.block, true);

      writeFileSync(join(configDir, "permission-gate.json"), JSON.stringify({ mode: "ask" }), "utf8");
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
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

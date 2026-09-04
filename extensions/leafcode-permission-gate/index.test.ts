import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import permissionGate, { matchSystemSafetyCommand, matchSystemSafetyForTool, matchSystemSafetyPath } from "./index";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function freshContext(cwd: string, sessionManager: ExtensionContext["sessionManager"]): ExtensionContext {
  // Pi's ExtensionRunner.createContext() returns a new object per event.
  return { cwd, hasUI: false, sessionManager } as ExtensionContext;
}

describe("system safety classifier", () => {
  it("covers OS, user data, kernel, driver, registry, service, boot, disk, and firmware mutations", () => {
    const cases: Array<[string, string]> = [
      ["Stop-Computer -Force", "os"],
      ["Remove-Item -Force $env:USERPROFILE\\Documents\\report.txt", "user-data"],
      ["modprobe v4l2loopback", "kernel"],
      ["pnputil /add-driver driver.inf /install", "driver"],
      ["reg.exe add HKLM\\Software\\LeafCode /v Enabled /t REG_DWORD /d 1", "registry"],
      ["systemctl stop leafcode.service", "service"],
      ["bcdedit /set {default} recoveryenabled no", "boot"],
      ["diskpart /s mutate-disk.txt", "disk"],
      ["fwupdmgr update", "firmware"],
    ];
    for (const [command, category] of cases) {
      assert.ok(
        matchSystemSafetyCommand(command).some((match) => match.category === category),
        `${category} was not detected in: ${command}`,
      );
    }

    assert.deepEqual(matchSystemSafetyCommand("cat /etc/hosts"), []);
    assert.deepEqual(matchSystemSafetyCommand("systemctl status leafcode.service"), []);
    assert.deepEqual(matchSystemSafetyCommand("bcdedit /enum"), []);
    assert.deepEqual(matchSystemSafetyCommand("fdisk -l /dev/sda"), []);
    assert.ok(matchSystemSafetyCommand("fdisk -l /dev/sda && dd if=/dev/zero of=/dev/sda").some((match) => match.category === "disk"));
    assert.ok(matchSystemSafetyCommand("diskutil list; diskutil eraseDisk APFS Empty /dev/disk2").some((match) => match.category === "disk"));
    assert.ok(matchSystemSafetyPath("C:\\Windows\\System32\\drivers\\example.sys").some((match) => match.category === "driver"));
    assert.ok(matchSystemSafetyPath("C:\\Users\\Daichi\\Documents\\report.txt").some((match) => match.category === "user-data"));
    assert.ok(matchSystemSafetyForTool("mcp__server__registry_set", { path: "HKLM\\Software\\LeafCode" }).some((match) => match.category === "registry"));
    assert.ok(matchSystemSafetyForTool("mcp__server__exec", { payload: { command: "systemctl stop leafcode.service" } }).some((match) => match.category === "service"));
    assert.ok(matchSystemSafetyForTool("mcp__server__file_tool", { target: "C:\\Windows\\System32\\config" }).some((match) => match.category === "os"));
    assert.deepEqual(matchSystemSafetyForTool("read", { path: "/etc/os-release" }), []);
  });
});

describe("LeafCode permission gate", () => {
  it("applies deny across separate ExtensionContext instances (Pi createContext)", async () => {
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

    try {
      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "deny" }), "utf8");
      await handlers.get("session_start")?.({}, freshContext(cwd, sessionManager));
      const bash = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "echo ok" } },
        freshContext(cwd, sessionManager),
      );
      const powershell = await handlers.get("tool_call")?.(
        { toolName: "powershell", input: { command: "Write-Output ok" } },
        freshContext(cwd, sessionManager),
      );
      assert.equal((bash as { block?: boolean } | undefined)?.block, true);
      assert.equal((powershell as { block?: boolean } | undefined)?.block, true);

      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "ask" }), "utf8");
      const askStart = {
        cwd,
        hasUI: true,
        sessionManager,
        ui: { select: async () => "No", notify: () => undefined },
      } as unknown as ExtensionContext;
      await handlers.get("session_start")?.({}, askStart);
      const askCall = {
        cwd,
        hasUI: true,
        sessionManager,
        ui: { select: async () => "No", notify: () => undefined },
      } as unknown as ExtensionContext;
      const dangerous = await handlers.get("tool_call")?.(
        { toolName: "powershell", input: { command: "Remove-Item -Recurse -Force target" } },
        askCall,
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

  it("picks up WebUI-written deny without relying on ctx mutation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-live-"));
    const appDir = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-live-data-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = appDir;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    permissionGate(pi);
    const sessionManager = {
      getSessionId: () => "live-mode-session",
      getSessionName: () => "Live mode",
    };

    try {
      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "allow" }), "utf8");
      await handlers.get("session_start")?.({}, freshContext(cwd, sessionManager));
      const allowed = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "echo ok" } },
        freshContext(cwd, sessionManager),
      );
      assert.equal((allowed as { block?: boolean } | undefined)?.block, undefined);

      // Simulate WebUI applyPermissionMode writing the file mid-session.
      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "deny" }), "utf8");
      const denied = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "echo ok" } },
        freshContext(cwd, sessionManager),
      );
      assert.equal((denied as { block?: boolean } | undefined)?.block, true);
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("requires read-only investigation, an impact/recovery plan, and explicit approval for system changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-safety-"));
    const appDir = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-safety-data-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = appDir;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    permissionGate(pi);
    const sessionManager = {
      getSessionId: () => "safety-session",
      getSessionName: () => "Safety",
    };

    try {
      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "allow" }), "utf8");
      await handlers.get("session_start")?.({}, freshContext(cwd, sessionManager));

      const direct = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "Stop-Computer -Force" } },
        freshContext(cwd, sessionManager),
      );
      assert.equal((direct as { block?: boolean } | undefined)?.block, true);
      assert.equal((direct as { terminate?: boolean } | undefined)?.terminate, true);
      assert.match(String((direct as { reason?: string } | undefined)?.reason), /read-only/);

      await handlers.get("tool_call")?.(
        { toolCallId: "failed-read", toolName: "read", input: { path: "/missing" } },
        freshContext(cwd, sessionManager),
      );
      await handlers.get("tool_result")?.(
        { toolCallId: "failed-read", toolName: "read", isError: true },
        freshContext(cwd, sessionManager),
      );
      await handlers.get("message_end")?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "対象はこの端末です。影響は再起動です。失敗時はバックアップから復旧します。" }],
          },
        },
        freshContext(cwd, sessionManager),
      );

      let prompt = "";
      const approvalContext = {
        cwd,
        hasUI: true,
        sessionManager,
        ui: {
          select: async (message: string) => {
            prompt = message;
            return "No";
          },
          notify: () => undefined,
        },
      } as unknown as ExtensionContext;
      const afterFailedRead = await handlers.get("tool_call")?.(
        { toolCallId: "unsafe-after-failure", toolName: "bash", input: { command: "Stop-Computer -Force" } },
        approvalContext,
      );
      assert.equal((afterFailedRead as { block?: boolean } | undefined)?.block, true);
      assert.equal(prompt, "");

      await handlers.get("tool_call")?.(
        { toolCallId: "successful-read", toolName: "read", input: { path: "/etc/os-release" } },
        freshContext(cwd, sessionManager),
      );
      await handlers.get("tool_result")?.(
        { toolCallId: "successful-read", toolName: "read", isError: false },
        freshContext(cwd, sessionManager),
      );
      await handlers.get("message_end")?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "対象はこの端末です。影響は再起動です。失敗時はバックアップから復旧します。" }],
          },
        },
        freshContext(cwd, sessionManager),
      );
      await handlers.get("input")?.({ text: "はい", source: "interactive" }, freshContext(cwd, sessionManager));

      const denied = await handlers.get("tool_call")?.(
        { toolCallId: "unsafe-approved-flow", toolName: "bash", input: { command: "Stop-Computer -Force" } },
        approvalContext,
      );
      assert.equal((denied as { block?: boolean } | undefined)?.block, true);
      assert.match(prompt, /明示的に許可/);

      const directUserBash = await handlers.get("user_bash")?.(
        { command: "systemctl stop leafcode.service", cwd },
        freshContext(cwd, sessionManager),
      );
      assert.match(String((directUserBash as { result?: { output?: string } } | undefined)?.result?.output), /System safety guard/);

      const customTool = await handlers.get("tool_call")?.(
        { toolCallId: "custom-secret", toolName: "mcp__server__exec", input: { token: "top-secret" } },
        freshContext(cwd, sessionManager),
      );
      const customReason = String((customTool as { reason?: string } | undefined)?.reason);
      assert.match(customReason, /details redacted/);
      assert.doesNotMatch(customReason, /top-secret/);
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("blocks .env* writes and shell bypasses of protected paths", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-protect-"));
    const appDir = mkdtempSync(join(tmpdir(), "leafcode-permission-gate-protect-data-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = appDir;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    permissionGate(pi);
    const sessionManager = {
      getSessionId: () => "protect-session",
      getSessionName: () => "Protect",
    };

    try {
      writeFileSync(join(appDir, "permission-gate.json"), JSON.stringify({ mode: "allow" }), "utf8");
      await handlers.get("session_start")?.({}, freshContext(cwd, sessionManager));

      const envLocal = await handlers.get("tool_call")?.(
        { toolName: "write", input: { path: ".env.local", content: "SECRET=1" } },
        freshContext(cwd, sessionManager),
      );
      assert.equal((envLocal as { block?: boolean } | undefined)?.block, true);

      const shellEnv = await handlers.get("tool_call")?.(
        {
          toolName: "powershell",
          input: { command: "Set-Content -Path .env -Value 'SECRET=1'" },
        },
        freshContext(cwd, sessionManager),
      );
      assert.equal((shellEnv as { block?: boolean } | undefined)?.block, true);

      const shellOk = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "echo hello" } },
        freshContext(cwd, sessionManager),
      );
      assert.equal((shellOk as { block?: boolean } | undefined)?.block, undefined);
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});

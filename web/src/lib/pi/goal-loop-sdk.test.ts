import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import goalLoopExtension from "../../../../extensions/leafcode-goal-loop/index";

it("starts, controls and completes Goal Loop through real SDK context dispatch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-sdk-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", cwd);
  vi.useFakeTimers();
  const manager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // The bundled extension resolves Pi types from the repo root; exercise it
    // against the WebUI's installed SDK (which can be a newer compatible version).
    extensionFactories: [goalLoopExtension as unknown as ExtensionFactory],
  });
  let runner: ExtensionRunner | undefined;
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const sendMessage = vi.fn();
    loaded.runtime.sendMessage = sendMessage;
    loaded.runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
    // No model calls: only the real SDK loader, commands and lifecycle dispatcher.
    runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, {} as ModelRegistry);
    const errors: unknown[] = [];
    runner.onError((error) => { errors.push(error); });
    const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
    const command = async (name: string, args = "") => {
      const registered = runner!.getCommand(name);
      expect(registered, name).toBeDefined();
      await registered!.handler(args, runner!.createCommandContext());
    };
    const settle = async (status: string) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ status, summary: status, evidence: "test passed" }) }],
        api: "openai-responses",
        provider: "test",
        model: "test",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      await runner!.emit({ type: "agent_end", messages: [message] });
      await runner!.emit({ type: "agent_settled", messages: [message] });
    };
    await runner.emit({ type: "session_start", reason: "startup" });
    expect(runner.createContext() === runner.createCommandContext()).toBe(false);
    await command("goal-start", Buffer.from(JSON.stringify({
      goal: "Fix the reported bug",
      acceptance: ["Regression tests pass"],
      maxTurns: 100,
      cooldownSeconds: 0,
      forceFullRun: false,
    })).toString("base64url"));
    expect(state()).toMatchObject({ status: "queued", maxTurns: 100, acceptance: ["Regression tests pass"] });
    await runner.emitInput("Keep the fix scoped", undefined, "rpc");
    expect(state().notes).toEqual(["Keep the fix scoped"]);
    await command("goal-pause");
    expect(state().status).toBe("paused");
    await command("goal-resume");
    await vi.advanceTimersByTimeAsync(1);
    expect(state().status).toBe("running");
    expect(sendMessage).toHaveBeenCalled();
    await settle("completed");
    expect(state().status).toBe("verifying_completed");
    await vi.advanceTimersByTimeAsync(250);
    expect(state().turnKind).toBe("verification");
    await settle("verified_completed");
    expect(state().status).toBe("completed");

    await command("goal", "Full run --full-run --turns 1");
    await vi.advanceTimersByTimeAsync(1);
    await settle("progress");
    expect(state()).toMatchObject({ status: "paused", pauseReason: "turn_limit" });
    await command("goal-complete");
    expect(state().status).toBe("completed");
    await command("goal-set", "Stop check");
    await command("goal-stop");
    expect(state().status).toBe("stopped");
    await command("goal-set", "Shutdown check");
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(state()).toMatchObject({ status: "paused", pauseReason: "" });
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await runner?.emit({ type: "session_shutdown", reason: "quit" });
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
  }
});

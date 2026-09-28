import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import goalLoopExtension, { HOST_ROUTING_CHANNEL } from "../../../../extensions/leafcode-goal-loop/index";

it("continues a queued Goal Loop across a real SDK session.reload during turn preparation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-reload-sdk-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(cwd, "data"));
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "turn one" })),
    fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "turn two" })),
  ]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  let prepareCount = 0;
  const goalLoopPath = fileURLToPath(new URL("../../../../extensions/leafcode-goal-loop/index.ts", import.meta.url));
  const slowStartupFactory: ExtensionFactory = (api) => {
    api.on("session_start", async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
    });
  };
  const routingFactory: ExtensionFactory = (api) => {
    const hostApi = api as unknown as {
      events: { emit: (channel: string, data?: unknown) => void };
      on: (name: string, handler: (event: unknown, ctx: Record<string, unknown>) => void) => void;
    };
    hostApi.events.emit(HOST_ROUTING_CHANNEL, { taskId: "reload-regression" });
    hostApi.on("session_start", (_event, ctx) => {
      const routingContext = ctx as Record<string, unknown> & {
        prepareGoalLoopTurn?: (prompt: string) => Promise<boolean | "retry">;
      };
      routingContext.prepareGoalLoopTurn = async () => {
        prepareCount += 1;
        if (prepareCount === 2) {
          await session.reload();
          return false;
        }
        return true;
      };
    });
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [goalLoopPath],
    extensionFactories: [slowStartupFactory, routingFactory],
  });
  try {
    await loader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: manager,
      modelRuntime,
      model: faux.getModel(),
      tools: [],
    });
    session = created.session;
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    const stateFile = join(cwd, "data", "goals-loop", `${manager.getSessionId()}.json`);
    const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
    const runner = session.extensionRunner as ExtensionRunner;
    const command = runner.getCommand("goal-start");
    expect(command).toBeDefined();
    await command!.handler(Buffer.from(JSON.stringify({
      goal: "Continue after reload",
      maxTurns: 2,
      cooldownSeconds: 0,
      forceFullRun: true,
    })).toString("base64url"), runner.createCommandContext());
    await vi.waitFor(() => expect(state()).toMatchObject({ status: "paused", pauseReason: "turn_limit", turnCount: 2 }), { timeout: 8_000, interval: 25 });
    expect(prepareCount).toBeGreaterThanOrEqual(3);
    expect(faux.state.callCount).toBe(2);
    expect(state().progress.map((item: { summary: string }) => item.summary)).toEqual(["turn one", "turn two"]);
  } finally {
    if (session!) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

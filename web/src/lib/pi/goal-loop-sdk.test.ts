import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import goalLoopExtension, { HOST_ROUTING_CHANNEL, HOST_ROUTING_READY_CHANNEL, goalLoopTestSeams } from "../../../../extensions/leafcode-goal-loop/index";
import { isGoalLoopCommandApplied } from "./goal-loop-command";
import { shouldApplySettledStatus } from "@backend-core/session-event-decisions.mjs";

it.each(["provider-abort", "timeout-abort"])("automatically retries an aborted Goal Loop turn through the real SDK without consuming its budget (%s)", async (cause) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-abort-sdk-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", cwd);
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  if (cause === "timeout-abort") goalLoopTestSeams.setTurnTimeoutMs(50);
  faux.setResponses([
    cause === "timeout-abort"
      ? async (_context, options) => {
        // The extension watchdog aborts a real in-flight SDK request.
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      }
      : fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }),
    fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "recovered" })),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [goalLoopExtension as unknown as ExtensionFactory],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager: manager,
      modelRuntime, model: faux.getModel(), tools: [],
    }));
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    const runner = session.extensionRunner;
    await runner.getCommand("goal-start")!.handler(Buffer.from(JSON.stringify({
      goal: "Recover after automatic abort", maxTurns: 1, forceFullRun: true,
    })).toString("base64url"), runner.createCommandContext());
    const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
    await vi.waitFor(() => expect(state()).toMatchObject({ status: "paused", pauseReason: "turn_limit", turnCount: 1 }), { timeout: 8_000, interval: 25 });
    expect(faux.state.callCount).toBe(2);
    expect(state().progress.map((item: { summary: string }) => item.summary)).toEqual(["recovered"]);
    const turns = manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "leafcode-goal-turn");
    expect(turns).toHaveLength(2);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    goalLoopTestSeams.setTurnTimeoutMs();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each([
  { promptActive: false, checkpoint: true, continuation: "none" },
  { promptActive: true, checkpoint: false, continuation: "none" },
  { promptActive: false, checkpoint: true, continuation: "goal" },
  { promptActive: true, checkpoint: false, continuation: "verification" },
])("keeps the run lease through settlement (promptActive=$promptActive, continuation=$continuation)", async ({ promptActive, checkpoint, continuation }) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-settlement-lease-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", cwd);
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  const responses = [
    fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "done" })),
    fauxAssistantMessage(JSON.stringify({ status: "verified_completed", summary: "verified" })),
  ];
  if (continuation !== "none") responses.splice(continuation === "goal" ? 0 : 1, 0,
    fauxAssistantMessage(JSON.stringify({ status: continuation === "goal" ? "completed" : "verified_completed", summary: "superseded claim" })));
  faux.setResponses(responses);
  let boundaryPending = false;
  let continued = false;
  let releaseBoundary!: () => void;
  const boundaryGate = new Promise<void>((resolve) => { releaseBoundary = resolve; });
  const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [goalLoopExtension as unknown as ExtensionFactory, (api) => {
      api.events.emit(HOST_ROUTING_CHANNEL, {});
      api.on("session_start", (_event, ctx) => {
        api.events.emit(HOST_ROUTING_READY_CHANNEL, {
          sessionManager: ctx.sessionManager,
          prepareGoalLoopTurn: async () => { ownsLease = true; return true; },
        });
      });
      // Extensions can still persist checkpoints or request continuation after agent_end.
      api.on("agent_before_settle", async () => {
        if (checkpoint) api.appendEntry("settle-checkpoint", {});
        if (continued || continuation === "none" || state().turnKind !== continuation) return;
        continued = true;
        boundaryPending = true;
        await boundaryGate;
        return {
          continue: true,
          entries: [{ type: "custom_message", customType: "lease-check-continue", content: "Recheck the claim", display: false }],
        };
      });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let ownsLease = false;
  const lostLeaseWrites: string[] = [];
  const endLeases: boolean[] = [];
  const snapshots: string[] = [];
  const errors: string[] = [];
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager: manager,
      modelRuntime, model: faux.getModel(), tools: [],
    }));
    // Mirror attachSession's write fence: an in-flight run without its lease is
    // aborted/disposed. The decision below is the production harness decision.
    const append = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = (type, data) => {
      if ((promptActive || session!.isStreaming) && !ownsLease) {
        lostLeaseWrites.push(type);
        session!.dispose();
        return "";
      }
      if (type === "leafcode-goal-loop") snapshots.push((data as { snapshot: { status: string } }).snapshot.status);
      return append(type, data);
    };
    session.subscribe((event) => {
      if (event.type === "agent_start") ownsLease = true;
      if (shouldApplySettledStatus(event, false)) ownsLease = false;
      if (event.type === "agent_end") endLeases.push(ownsLease);
    });
    // Start commands and host preparation own their lease before writing.
    ownsLease = true;
    await session.bindExtensions({ onError: (error) => { errors.push(error.error); } });
    await session.prompt(`/goal-start ${Buffer.from(JSON.stringify({ goal: "Verify completion", maxTurns: 1 })).toString("base64url")}`);
    await vi.waitFor(() => expect(endLeases.length).toBeGreaterThan(0), { timeout: 3_000, interval: 10 });
    expect(lostLeaseWrites).toEqual([]);
    expect(endLeases[0]).toBe(true);
    if (continuation !== "none") {
      await vi.waitFor(() => expect(boundaryPending).toBe(true), { timeout: 3_000, interval: 10 });
      expect(ownsLease).toBe(true);
      expect(state()).toMatchObject({ status: "running", turnCount: 1, turnKind: continuation });
      expect(session.isStreaming).toBe(true);
      releaseBoundary();
    }
    await vi.waitFor(() => expect(state()).toMatchObject({ status: "completed", turnCount: 1 }), { timeout: 3_000, interval: 10 });
    await session.waitForIdle();
    expect(lostLeaseWrites).toEqual([]);
    expect(endLeases).toEqual(responses.map(() => true));
    expect(snapshots).toContain("verifying_completed");
    expect(snapshots).toContain("completed");
    expect(state().progress.map((item: { summary: string }) => item.summary)).toEqual(["done", "verified"]);
    expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "leafcode-goal-turn")).toHaveLength(1);
    expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "leafcode-goal-verification")).toHaveLength(1);
    expect(faux.state.callCount).toBe(responses.length);
    expect(ownsLease).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    releaseBoundary();
    ownsLease = true;
    await session?.abort();
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("resumes blocked final-turn verification through the real SDK without more goal turns", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-verification-sdk-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", cwd);
  const manager = SessionManager.inMemory(cwd);
  const stateFile = join(cwd, "goals-loop", `${manager.getSessionId()}.json`);
  let pendingVerification: Record<string, unknown> | undefined;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "done" })),
    fauxAssistantMessage(JSON.stringify({ status: "blocked", summary: "check needs input" })),
    () => {
      pendingVerification = JSON.parse(readFileSync(stateFile, "utf8"));
      return fauxAssistantMessage(JSON.stringify({ status: "verified_completed", summary: "verified" }));
    },
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [goalLoopExtension as unknown as ExtensionFactory],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager: manager,
      modelRuntime, model: faux.getModel(), tools: [],
    }));
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    const runner = session.extensionRunner;
    const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
    await runner.getCommand("goal-start")!.handler(Buffer.from(JSON.stringify({ goal: "Verify the final turn", maxTurns: 1 })).toString("base64url"), runner.createCommandContext());
    await vi.waitFor(() => expect(state()).toMatchObject({ status: "blocked", turnKind: "verification", turnCount: 1 }), { timeout: 5_000, interval: 10 });
    await session.waitForIdle();
    await runner.getCommand("goal-resume")!.handler("", runner.createCommandContext());
    await vi.waitFor(() => expect(state()).toMatchObject({ status: "completed", turnCount: 1, maxTurns: 1 }), { timeout: 5_000, interval: 10 });
    expect(faux.state.callCount).toBe(3);
    expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "leafcode-goal-turn")).toHaveLength(1);
    expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "leafcode-goal-verification")).toHaveLength(2);
    await session.waitForIdle();
    // A lifecycle write can precede the final transcript result while its
    // settlement write is lost. Restore that snapshot, not a fabricated result.
    expect(pendingVerification).toMatchObject({ status: "running", turnKind: "verification" });
    writeFileSync(stateFile, JSON.stringify({ ...pendingVerification, status: "paused", pauseReason: "session_end", pendingTurnRecovery: true, retryInterruptedTurn: true }), "utf8");
    await runner.getCommand("goal-resume")!.handler("", runner.createCommandContext());
    expect(state()).toMatchObject({ status: "completed", turnCount: 1, pendingTurnRecovery: false });
    expect(isGoalLoopCommandApplied("resume", state())).toBe(true);
    expect(faux.state.callCount).toBe(3);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Regression: a raw-fetch "terminated" error stopped session 01a100cf while
// retry.enabled was false. Keep recovery inside the SDK's bounded retry policy,
// not a new Goal Loop turn (which could replay already completed tool actions).
it.each(["recovered", "exhausted", "disabled", "manual-stop"])("handles terminated through real SDK retries without duplicating Goal Loop turns (%s)", async (outcome) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-terminated-sdk-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", cwd);
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
  faux.setResponses(outcome === "exhausted"
    ? Array.from({ length: 4 }, failure)
    : [failure(), fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "recovered" }))]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: {
    enabled: outcome !== "disabled", maxRetries: 3,
    baseDelayMs: outcome === "manual-stop" ? 500 : 10, maxAgentDelayMs: 500,
  } });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [goalLoopExtension as unknown as ExtensionFactory],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager: manager,
      modelRuntime, model: faux.getModel(), tools: [],
    }));
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    const retries: number[] = [];
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") retries.push(event.attempt);
    });
    const runner = session.extensionRunner;
    const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
    await runner.getCommand("goal-start")!.handler(Buffer.from(JSON.stringify({
      goal: "Recover a broken response stream", maxTurns: 1, forceFullRun: true,
    })).toString("base64url"), runner.createCommandContext());
    if (outcome === "manual-stop") {
      await vi.waitFor(() => expect(retries).toEqual([1]), { timeout: 2_000, interval: 5 });
      await runner.getCommand("goal-stop")!.handler("", runner.createCommandContext());
      await session.waitForIdle();
      // Wait beyond the cancelled backoff to catch a stray restart.
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(state()).toMatchObject({ status: "stopped", turnCount: 1 });
    } else {
      await vi.waitFor(() => expect(state()).toMatchObject({
        status: "paused", turnCount: 1,
        pauseReason: outcome === "recovered" ? "turn_limit" : "scheduler_error",
      }), { timeout: 5_000, interval: 10 });
      if (outcome !== "recovered") expect(state().error).toBe("terminated");
    }
    expect(faux.state.callCount).toBe(outcome === "recovered" ? 2 : outcome === "exhausted" ? 4 : 1);
    expect(retries).toEqual(outcome === "exhausted" ? [1, 2, 3] : outcome === "disabled" ? [] : [1]);
    expect(state().progress.map((item: { summary: string }) => item.summary)).toEqual(outcome === "recovered" ? ["recovered"] : []);
    const turns = manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "leafcode-goal-turn");
    expect(turns).toHaveLength(1);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

it.each(["queued", "preparing"])("starts a %s Goal Loop after a replacement loads a fresh extension module", async (phase) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-replace-sdk-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(cwd, "data"));
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const file = manager.getSessionFile()!;
  writeFileSync(file, JSON.stringify(manager.getHeader()) + "\n", "utf8");
  manager.setSessionFile(file);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "first turn" }))]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  let releasePrepare!: () => void;
  const prepareGate = new Promise<boolean>((resolve) => { releasePrepare = () => resolve(true); });
  let prepareCount = 0;
  const routingFactory: ExtensionFactory = (api) => {
    api.events.emit(HOST_ROUTING_CHANNEL, {});
    api.on("session_start", (_event, ctx) => {
      (ctx as typeof ctx & { prepareGoalLoopTurn?: () => Promise<boolean> }).prepareGoalLoopTurn = async () => {
        prepareCount += 1;
        return phase === "preparing" && prepareCount === 1 ? prepareGate : true;
      };
    });
  };
  const goalLoopPath = fileURLToPath(new URL("../../../../extensions/leafcode-goal-loop/index.ts", import.meta.url));
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
    extensionFactories: [routingFactory],
  });
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  try {
    await loader.reload();
    const original = (await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: manager, modelRuntime, model: faux.getModel(), tools: [],
    })).session;
    sessions.push(original);
    vi.useFakeTimers();
    await original.bindExtensions({});
    await original.prompt(`/goal-start ${Buffer.from(JSON.stringify({
      goal: "Start after replacement", maxTurns: 1, cooldownSeconds: 0, forceFullRun: true,
    })).toString("base64url")}`);
    const stateFile = join(cwd, "data", "goals-loop", `${manager.getSessionId()}.json`);
    const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state()).toMatchObject({ status: "queued", turnCount: 0 });
    if (phase === "preparing") {
      await vi.advanceTimersByTimeAsync(1);
      expect(prepareCount).toBe(1);
    }

    // Like an Auto-agent/account replacement after another session's /reload:
    // import a fresh module, bind the successor, then dispose without shutdown.
    await loader.reload();
    const successor = (await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.open(file), modelRuntime, model: faux.getModel(), tools: [],
    })).session;
    sessions.push(successor);
    expect(successor.sessionId).toBe(original.sessionId);
    await successor.bindExtensions({});
    original.dispose();
    releasePrepare();
    // Delayed shutdown from the retired module must not pause the successor.
    await original.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(state()).toMatchObject({ status: "queued", turnCount: 0 });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(state()).toMatchObject({ status: "paused", pauseReason: "turn_limit", turnCount: 1 }));
    expect(faux.state.callCount).toBe(1);
    // Old module's scheduler/watchdog must be retired, not left with stale ctx.
    await successor.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each(["attached", "late-after-timeout", "rebound"])("requires session-scoped host routing on start/resume (%s)", async (phase) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-routing-sdk-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", cwd);
  vi.useFakeTimers();
  const manager = SessionManager.inMemory(cwd);
  let publishRouting!: (sessionManager?: object) => void;
  const prepare = vi.fn(async () => true);
  const release = vi.fn();
  const canRetry = vi.fn(async () => false);
  const routingFactory: ExtensionFactory = (api) => {
    api.events.emit(HOST_ROUTING_CHANNEL, {});
    api.on("session_start", (_event, ctx) => {
      // The host must not depend on sharing this exact ctx object with Goal Loop.
      const hostCtx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx)) as typeof ctx;
      publishRouting = (sessionManager = hostCtx.sessionManager) => api.events.emit("leafcode-goal-loop:host-routing-ready", {
        sessionManager, prepareGoalLoopTurn: prepare,
        releaseGoalLoopTurn: release, canRetryGoalLoopProviderLimit: canRetry,
      });
      if (phase !== "late-after-timeout") publishRouting();
    });
  };
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [goalLoopExtension as unknown as ExtensionFactory, routingFactory],
  });
  let runner: ExtensionRunner | undefined;
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const sendMessage = vi.fn();
    loaded.runtime.sendMessage = sendMessage;
    loaded.runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
    runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, {} as ModelRegistry);
    const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
    await runner.emit({ type: "session_start", reason: "startup" });
    await runner.getCommand("goal-start")!.handler(Buffer.from(JSON.stringify({ goal: "Use host routing", maxTurns: 2 })).toString("base64url"), runner.createCommandContext());
    if (phase === "late-after-timeout") {
      // Another session's ready event must not satisfy this session's handshake.
      publishRouting({});
      await vi.advanceTimersByTimeAsync(15_001);
      expect(state()).toMatchObject({ status: "paused", pauseReason: "scheduler_error", turnCount: 0 });
      await runner.getCommand("goal-resume")!.handler("", runner.createCommandContext());
      await vi.advanceTimersByTimeAsync(1);
      expect(state()).toMatchObject({ status: "queued", turnCount: 0 });
      expect(sendMessage.mock.calls.filter(([message]) => message.customType === "leafcode-goal-turn")).toHaveLength(0);
      publishRouting();
      await vi.advanceTimersByTimeAsync(250);
    } else {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ status: "running", turnCount: 1 });
    expect(sendMessage.mock.calls.filter(([message]) => message.customType === "leafcode-goal-turn")).toHaveLength(1);
    if (phase === "rebound") {
      await runner.getCommand("goal-stop")!.handler("", runner.createCommandContext());
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await runner.emit({ type: "session_start", reason: "startup" });
      await runner.getCommand("goal-start")!.handler(Buffer.from(JSON.stringify({ goal: "Start again" })).toString("base64url"), runner.createCommandContext());
      await vi.advanceTimersByTimeAsync(1);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(state()).toMatchObject({ status: "running", turnCount: 1 });
      expect(sendMessage.mock.calls.filter(([message]) => message.customType === "leafcode-goal-turn")).toHaveLength(2);
    }
  } finally {
    await runner?.emit({ type: "session_shutdown", reason: "quit" });
    vi.useRealTimers();
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
    expect(state()).toMatchObject({ status: "paused", pauseReason: "session_end" });
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await runner?.emit({ type: "session_shutdown", reason: "quit" });
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
  }
});

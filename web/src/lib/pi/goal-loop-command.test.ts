import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import goalLoopExtension from "../../../../extensions/leafcode-goal-loop/index";
import { buildGoalLoopResumeCommand, dispatchGoalLoopCommand, isGoalLoopCommandApplied } from "./goal-loop-command";

it("acknowledges a resume that recovered completed verification, but not a new start", () => {
  expect(isGoalLoopCommandApplied("resume", { status: "completed" })).toBe(true);
  expect(isGoalLoopCommandApplied("start", { status: "completed" })).toBe(false);
  for (const status of ["paused", "blocked", "stopped", "unknown"]) {
    expect(isGoalLoopCommandApplied("resume", { status })).toBe(false);
  }
  expect(isGoalLoopCommandApplied("resume", null)).toBe(false);
});

it.each(["pause", "stop", "complete", "start", "resume"] as const)("applies %s immediately while the real SDK is settling", async (action) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-control-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(cwd, "data"));
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "first turn" }))]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  let releaseSettled!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSettled = resolve; });
  let settling = false;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [goalLoopExtension, (api) => {
      api.on("agent_settled", async () => { settling = true; await gate; });
    }],
  });
  let session: AgentSession | undefined;
  try {
    await loader.reload();
    session = (await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: manager, modelRuntime, model: faux.getModel(), tools: [],
    })).session;
    await session.bindExtensions({});
    const state = () => JSON.parse(readFileSync(join(cwd, "data", "goals-loop", `${manager.getSessionId()}.json`), "utf8"));
    await dispatchGoalLoopCommand(session, `/goal-start ${Buffer.from(JSON.stringify({
      goal: "Exercise immediate controls", maxTurns: action === "complete" ? 1 : 2, forceFullRun: true,
    })).toString("base64url")}`);
    await vi.waitFor(() => expect(settling).toBe(true));
    const before = action === "complete" ? "paused" : "queued";
    expect(state().status).toBe(before);
    if (action === "resume") {
      await dispatchGoalLoopCommand(session, "/goal-pause");
      expect(state().status).toBe("paused");
    }
    const expected = { pause: "paused", stop: "stopped", complete: "completed", start: "queued", resume: "queued" }[action];
    const command = action === "start"
      ? `/goal-start ${Buffer.from(JSON.stringify({ goal: "replacement", maxTurns: 20 })).toString("base64url")}`
      : action === "resume" ? "/goal-resume --turns 20" : `/goal-${action}`;
    if (action !== "start" && action !== "resume") {
      // The old control path returns success but only queues the command.
      await session.prompt(command);
      expect(state().status).toBe(before);
    }
    await dispatchGoalLoopCommand(session, command);
    expect(state().status).toBe(expected);
    if (action === "start") expect(state()).toMatchObject({ goal: "replacement", turnCount: 0 });
    if (action === "resume") expect(state().maxTurns).toBe(20);
    if (action === "start" || action === "resume") await dispatchGoalLoopCommand(session, "/goal-stop");
    expect(faux.state.callCount).toBe(1);
    releaseSettled();
    await session.waitForIdle();
    expect(state().status).toBe(action === "start" || action === "resume" ? "stopped" : expected);
    expect(faux.state.callCount).toBe(1);
  } finally {
    releaseSettled();
    if (session) {
      await session.waitForIdle();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each([
  ["/goal-start payload", "goal-start", "payload"],
  ["/goal-resume --turns 20", "goal-resume", "--turns 20"],
  ["/goal-resume --restart-prompt cmVzdGFydA", "goal-resume", "--restart-prompt cmVzdGFydA"],
])("dispatches %s directly without leaving a deferred SDK action", async (command, name, args) => {
  const prompt = vi.fn(); const handler = vi.fn(); const context = {};
  const session = { prompt, extensionRunner: { getCommand: vi.fn(() => ({ handler })), createCommandContext: () => context } } as unknown as AgentSession;
  await dispatchGoalLoopCommand(session, command);
  expect(session.extensionRunner.getCommand).toHaveBeenCalledWith(name);
  expect(handler).toHaveBeenCalledWith(args, context);
  expect(prompt).not.toHaveBeenCalled();
});

it("encodes restart recovery instructions in the Goal Loop resume command", () => {
  const prompt = "WebUI restart; do not repeat completed operations.";
  const encoded = Buffer.from(prompt, "utf8").toString("base64url");
  expect(buildGoalLoopResumeCommand({ maxTurns: 5, restartPrompt: prompt }))
    .toBe(`/goal-resume --turns 5 --restart-prompt ${encoded}`);
  expect(buildGoalLoopResumeCommand({ restartPrompt: "  " })).toBe("/goal-resume");
});

it("rejects missing controls without sending them to the model", async () => {
  const prompt = vi.fn();
  const session = { prompt, extensionRunner: { getCommand: () => undefined } } as unknown as AgentSession;
  await expect(dispatchGoalLoopCommand(session, "/goal-pause")).rejects.toMatchObject({ status: 409 });
  expect(prompt).not.toHaveBeenCalled();
});

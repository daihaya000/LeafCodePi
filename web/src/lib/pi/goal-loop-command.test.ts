import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import goalLoopExtension from "../../../../extensions/leafcode-goal-loop/index";
import { dispatchGoalLoopCommand } from "./goal-loop-command";

it.each(["pause", "stop", "complete"] as const)("applies %s immediately while the real SDK is settling", async (action) => {
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
    // Reproduce the old path: prompt returns success but only queues the control.
    await session.prompt(`/goal-${action}`);
    expect(state().status).toBe(before);
    await dispatchGoalLoopCommand(session, `/goal-${action}`);
    expect(state().status).toBe({ pause: "paused", stop: "stopped", complete: "completed" }[action]);
    expect(faux.state.callCount).toBe(1);
    releaseSettled();
    await session.waitForIdle();
    expect(state().status).toBe({ pause: "paused", stop: "stopped", complete: "completed" }[action]);
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

it.each(["/goal-start payload", "/goal-resume --turns 20"])("keeps %s on the normal SDK prompt path", async (command) => {
  const prompt = vi.fn();
  await dispatchGoalLoopCommand({ prompt } as unknown as AgentSession, command);
  expect(prompt).toHaveBeenCalledWith(command);
});

it("rejects missing controls without sending them to the model", async () => {
  const prompt = vi.fn();
  const session = { prompt, extensionRunner: { getCommand: () => undefined } } as unknown as AgentSession;
  await expect(dispatchGoalLoopCommand(session, "/goal-pause")).rejects.toMatchObject({ status: 409 });
  expect(prompt).not.toHaveBeenCalled();
});

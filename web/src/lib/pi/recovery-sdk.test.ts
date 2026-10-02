import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { customPromptWithRuntimeClock, refreshRuntimeClock } from "./harness";

// Real SDK contract, no HTTP or OAuth: sendCustomMessage(triggerTurn) bypasses
// before_agent_start and must carry the clock without mutating read-only state.
it.each([
  "leafcode-pi.provider-fallback",
  "leafcode-pi.provider-transport-recovery",
  "bot-code-result",
])("resumes a fresh real SDK session with a clock (%s)", async (customType) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-recovery-sdk-"));
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  let requestText = "";
  faux.setResponses([async (context) => {
    requestText = JSON.stringify(context);
    return fauxAssistantMessage("recovered");
  }]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  let beforeAgentStartCalls = 0;
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(api) => {
      api.on("before_agent_start", () => { beforeAgentStartCalls += 1; });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, settingsManager,
      sessionManager: manager, modelRuntime, model: faux.getModel(), tools: [],
    }));
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    const activeSession = session;
    expect(() => refreshRuntimeClock(activeSession)).not.toThrow();
    await session.sendCustomMessage({
      customType,
      content: customPromptWithRuntimeClock("Continue without repeating completed actions.", new Date("2026-10-02T09:00:00Z")),
      display: false,
    }, { triggerTurn: true });

    expect(beforeAgentStartCalls).toBe(0);
    expect(faux.state.callCount).toBe(1);
    expect(requestText).toContain("<host_clock>");
    expect(requestText).toContain("UTC: 2026-10-02T09:00:00.000Z");
    expect(requestText).toContain("Continue without repeating completed actions.");
    expect(session.agent.state.errorMessage).toBeUndefined();
    const turns = manager.getBranch().filter((entry) => entry.type === "custom_message");
    expect(turns).toMatchObject([{ customType, display: false }]);
    expect(manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user")).toBe(false);
  } finally {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

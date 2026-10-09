import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { overrideSessionAutoRetry } from "@backend-core/session-retry-settings.mjs";

it("keeps temporary retry suppression out of shared settings, including disposal before restore", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-retry-settings-"));
  try {
    const first = SettingsManager.create(cwd, cwd);
    const peer = SettingsManager.create(cwd, cwd);
    const session = { settingsManager: first };
    expect(first.getRetryEnabled()).toBe(true);
    expect(overrideSessionAutoRetry(session, false)).toBe(true);
    expect(first.getRetrySettings().enabled).toBe(false);
    await first.flush();
    expect(first.getGlobalSettings().retry?.enabled).toBeUndefined();
    expect(peer.getRetryEnabled()).toBe(true);
    // A replacement session must not inherit the first session's suppression,
    // even if it crashed/disposed without reaching agent_settled.
    expect(SettingsManager.create(cwd, cwd).getRetryEnabled()).toBe(true);
    expect(overrideSessionAutoRetry(session, true)).toBe(true);
    expect(first.getRetrySettings().enabled).toBe(true);
    await first.flush();
    expect(first.getGlobalSettings().retry?.enabled).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("never falls back to the persistent SDK setter", () => {
  let writes = 0;
  const legacy = { setAutoRetryEnabled: () => { writes += 1; }, settingsManager: undefined };
  expect(overrideSessionAutoRetry(legacy, false)).toBe(false);
  expect(writes).toBe(0);
});

// Real SDK/faux provider: retry the failed model response, not the completed tool.
it.each(["recovered", "exhausted", "manual-stop", "disabled"])("handles interrupted streams without replaying a completed tool (%s)", async (outcome) => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-terminated-retry-"));
  const manager = SessionManager.inMemory(cwd);
  const faux = fauxProvider();
  let toolCalls = 0;
  const completedTool = fauxAssistantMessage([fauxToolCall("record", {})], { stopReason: "toolUse" });
  const failure = () => fauxAssistantMessage([fauxToolCall("record", {})], {
    stopReason: "error", errorMessage: "terminated",
  });
  faux.setResponses([completedTool, ...Array.from({ length: outcome === "exhausted" ? 4 : 1 }, failure), fauxAssistantMessage("recovered")]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: {
    enabled: outcome !== "disabled", maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 30,
  } });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(api) => {
      api.registerTool({
        name: "record", label: "record", description: "Record exactly once", parameters: Type.Object({}),
        execute: async () => { toolCalls += 1; return { content: [{ type: "text", text: "done" }], details: {} }; },
      });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager: manager,
      modelRuntime, model: faux.getModel(), tools: ["record"],
    }));
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    const retries: number[] = [];
    let stop: Promise<void> | undefined;
    session.subscribe((event) => {
      if (event.type !== "auto_retry_start") return;
      retries.push(event.attempt);
      if (outcome === "manual-stop") stop = session!.abort();
    });
    await session.prompt("Record once, then summarize.");
    await stop;
    expect(toolCalls).toBe(1);
    expect(retries).toEqual(outcome === "exhausted" ? [1, 2, 3] : outcome === "disabled" ? [] : [1]);
    expect(faux.state.callCount).toBe(outcome === "exhausted" ? 5 : outcome === "recovered" ? 3 : 2);
    if (outcome === "recovered") expect(session.agent.state.errorMessage).toBeUndefined();
    else if (outcome !== "manual-stop") expect(session.agent.state.errorMessage).toBe("terminated");
  } finally {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

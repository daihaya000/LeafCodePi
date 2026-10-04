import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { canInterruptForSteer } from "./impact-aware-steer";

it("cancels a real SDK generation and accepts the new instruction without its old response", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-immediate-sdk-"));
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const faux = fauxProvider();
  faux.setResponses([
    (_context, options) => new Promise((resolve) => {
      const finish = () => {
        cancelled = true;
        resolve(fauxAssistantMessage([], { stopReason: "aborted" }));
      };
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener("abort", finish, { once: true });
      started.resolve();
    }),
    fauxAssistantMessage("new response"),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(root), modelRuntime, model: faux.getModel(), tools: [] });
  try {
    const running = session.prompt("old instruction");
    await started.promise;
    expect(canInterruptForSteer({
      isStreaming: session.isStreaming && session.agent.state.isStreaming,
      isCompacting: session.isCompacting, blocked: false,
      pendingMessageCount: session.pendingMessageCount, promptQueueDepth: 1, activeToolNames: [],
    })).toBe(true);
    await session.abort();
    await running;
    expect(cancelled).toBe(true);
    expect(session.isStreaming).toBe(false);
    await session.prompt("new instruction");
    const users = session.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users[1])).toContain("new instruction");
    expect(JSON.stringify(session.messages.at(-1))).toContain("new response");
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 10_000);

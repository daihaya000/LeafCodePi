import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  generateSummaryWithUsage, buildSessionProjection, findCutPoint, estimateTokens,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { registerCompactionController, type CompactionControllerOptions } from "./compaction-controller";
import { compactSinglePass } from "./single-pass-compaction";
import { prepareBackgroundCompaction } from "./prepare-background-compaction";

const sdk = { buildSessionProjection, findCutPoint, estimateTokens };
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

async function runtime(factory: (pi: ExtensionAPI) => void) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-compaction-sdk-"));
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [],
    compaction: { enabled: false, keepRecentTokens: 10 } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [factory] });
  await resourceLoader.reload();
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const manager = SessionManager.inMemory(root);
  manager.appendMessage(user("old history ".repeat(100)));
  manager.appendMessage(fauxAssistantMessage("old decision ".repeat(100)));
  manager.appendMessage(user("active goal ".repeat(100)));
  manager.appendMessage(fauxAssistantMessage("progress ".repeat(100)));
  manager.appendMessage(fauxAssistantMessage("latest tail ".repeat(100)));
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager,
    sessionManager: manager, modelRuntime, model: faux.getModel(), tools: [] });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  return { session, manager, faux, cleanup: () => {
    session.dispose(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

it("the real SDK persists a single-pass split-turn checkpoint with usage", async () => {
  const summarize = vi.fn<CompactionControllerOptions["summarize"]>((request) => compactSinglePass({
    generate: generateSummaryWithUsage, preparation: request.preparation, branch: request.branch,
    model: request.ctx.model!, streamFn: (model, context, options) => request.ctx.modelRegistry.streamSimple(model, context, options),
    signal: request.signal, customInstructions: request.customInstructions,
    summaryMaxTokens: 2048, mode: request.mode,
  }));
  const standalone = vi.fn();
  const env = await runtime((api) => {
    // The path extension runs first. Pi's real event bus must claim ownership
    // synchronously before this handler starts another model request.
    api.on("session_before_compact", () => {
      const owner = { claimed: false };
      api.events.emit("leafcode:compaction:owner", owner);
      if (!owner.claimed) standalone();
    });
    registerCompactionController(api, {
      config: () => undefined, prepare: async () => undefined, summarize,
    });
  });
  const calls = vi.fn(() => fauxAssistantMessage("checkpoint: keep active goal and old decision"));
  env.faux.setResponses([calls]);
  try {
    const before = env.manager.getBranch().map((entry) => entry.id);
    const result = await env.session.compact("preserve exact paths");
    expect(summarize).toHaveBeenCalledOnce();
    expect(standalone).not.toHaveBeenCalled();
    expect(summarize.mock.calls[0][0].preparation.isSplitTurn).toBe(true);
    expect(summarize.mock.calls[0][0].preparation.messagesToSummarize.length).toBeGreaterThan(0);
    expect(summarize.mock.calls[0][0].preparation.turnPrefixMessages.length).toBeGreaterThan(0);
    expect(calls).toHaveBeenCalledOnce();
    expect(result.summary).toContain("checkpoint:");
    const entry = env.manager.getBranch().at(-1);
    expect(entry).toMatchObject({ type: "compaction", fromHook: true, usage: expect.any(Object) });
    expect(env.manager.getBranch().slice(0, before.length).map((entry) => entry.id)).toEqual(before);
    expect(JSON.stringify(env.session.messages)).toContain("latest tail");
  } finally { env.cleanup(); }
}, 10_000);

it("the real SDK applies a ready boundary draft without extra model turns and can resume it", async () => {
  let allowBackground = true;
  const ready = Promise.withResolvers<void>();
  const summarize = vi.fn<CompactionControllerOptions["summarize"]>(async (request) => {
    ready.resolve();
    return { summary: "background checkpoint", firstKeptEntryId: request.preparation.firstKeptEntryId,
      tokensBefore: request.preparation.tokensBefore, usage: fauxAssistantMessage("x").usage };
  });
  const env = await runtime((api) => registerCompactionController(api, {
    config: () => ({ enabled: allowBackground, startPercent: 0, key: "stable",
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 10 } }),
    prepare: async (branch, settings) => prepareBackgroundCompaction(sdk, branch, settings),
    summarize, minDeltaTokens: 0,
  }));
  const main = vi.fn(() => fauxAssistantMessage("main response"));
  env.faux.setResponses([main, main]);
  try {
    await env.session.prompt("continue");
    await ready.promise;
    // If generation finishes after final settlement, the next ordinary turn is the
    // commit boundary. Neither readiness nor the compaction itself may create a turn.
    await env.session.prompt("next ordinary turn");
    allowBackground = false;
    expect(main).toHaveBeenCalledTimes(2);
    const branch = env.manager.getBranch();
    const checkpoints = branch.filter((entry) => entry.type === "compaction");
    expect(checkpoints).toHaveLength(1);
    const projection = buildSessionProjection(branch);
    expect(JSON.stringify(projection.messages)).toContain("background checkpoint");
    expect(JSON.stringify(projection.messages)).toContain("next ordinary turn");
    const resumed = SessionManager.inMemory(process.cwd(), undefined, [env.manager.getHeader()!, ...branch]);
    expect(JSON.stringify(resumed.buildSessionProjection().messages)).toBe(JSON.stringify(projection.messages));
  } finally { env.cleanup(); }
}, 10_000);

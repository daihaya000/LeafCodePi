import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakePi = vi.hoisted(() => {
  type FakeEvent = { type: string; willRetry?: boolean; messages?: unknown[] };
  const histories = new Map<string, unknown[]>();
  const sessionIds = new Map<string, string>();
  const sessions: {
    accountId: string | null;
    modelID: string | null;
    file: string;
    prompts: string[];
    customMessages: unknown[];
    history: unknown[];
    disposed: boolean;
    nextError?: string;
    emit?: (event: FakeEvent) => void;
  }[] = [];

  function manager(cwd: string, file: string) {
    let name: string | undefined;
    const history = histories.get(file) ?? [];
    histories.set(file, history);
    const sessionId = sessionIds.get(file) ?? `session-${sessionIds.size + 1}`;
    sessionIds.set(file, sessionId);
    return {
      __file: file,
      __sessionId: sessionId,
      getSessionName: () => name,
      appendSessionInfo: (next: string) => {
        name = next;
      },
      getCwd: () => cwd,
      getSessionId: () => sessionId,
      getEntries: () => [],
      getLeafId: () => null,
      getBranch: () => [],
      // The harness guards every SDK writer at attach time. This fixture exercises messages only;
      // keep the other writers callable, but fail loudly rather than fabricate successful writes.
      ...Object.fromEntries([
        "appendModelChange", "appendThinkingLevelChange", "appendUsage", "appendCompaction",
        "appendContextEdit", "appendLabelChange", "branchWithSummary", "createBranchedSession",
      ].map((method) => [method, () => { throw new Error(`Unsupported limit-fallback fixture operation: ${method}`); }])),
      appendMessage: (message: unknown) => {
        history.push(message);
        return `message-${history.length}`;
      },
      appendCustomMessageEntry: (customType: string, content: unknown, display: boolean, details?: unknown) => {
        history.push({ role: "custom", customType, content, display, details, timestamp: Date.now() });
        return `custom-message-${history.length}`;
      },
      appendCustomEntry: () => undefined,
      history,
    };
  }

  return {
    sessions,
    reset: () => {
      sessions.length = 0;
      histories.clear();
      sessionIds.clear();
    },
    getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? "",
    DefaultResourceLoader: class {
      async reload() {}
      getExtensions() {
        return { extensions: [], errors: [] };
      }
    },
    SessionManager: {
      create: (cwd: string) => manager(cwd, join(cwd, "session.jsonl")),
      open: (file: string) => manager(dirname(file), file),
    },
    createAgentSession: async (options: {
      sessionManager: ReturnType<typeof manager>;
      model?: { id?: string };
      modelRuntime?: { accountId?: string };
      thinkingLevel?: ThinkingLevel;
    }) => {
      const sessionManager = options.sessionManager;
      const entry = {
        accountId: options.modelRuntime?.accountId ?? null,
        modelID: options.model?.id ?? null,
        file: sessionManager.__file,
        prompts: [] as string[],
        customMessages: [] as unknown[],
        history: sessionManager.history,
        disposed: false,
        nextError: undefined as string | undefined,
        emit: undefined as ((event: FakeEvent) => void) | undefined,
      };
      const listeners = new Set<(event: FakeEvent) => void>();
      const emit = (event: FakeEvent) => {
        for (const listener of listeners) listener(event);
      };
      entry.emit = emit;
      let streaming = false;
      const runTurn = (
        historyMessage: unknown, promptText: string,
        appendHistory = () => sessionManager.appendMessage(historyMessage),
      ) => {
        streaming = true;
        emit({ type: "agent_start" });
        entry.prompts.push(promptText);
        appendHistory();
        const errorMessage = entry.nextError;
        entry.nextError = undefined;
        streaming = false;
        emit({
          type: "agent_end",
          willRetry: false,
          messages: errorMessage ? [{ role: "assistant", errorMessage }] : [],
        });
        emit({ type: "agent_settled" });
      };
      const session = {
        sessionFile: sessionManager.__file,
        sessionId: sessionManager.__sessionId,
        sessionManager,
        messages: sessionManager.history,
        agent: {
          state: {
            // SDK 1.0: a plain writable fake hid fallback-resume failures.
            get systemPrompt() { return "base"; },
            errorMessage: undefined,
            streamingMessage: undefined,
          },
        },
        model: options.model,
        thinkingLevel: options.thinkingLevel ?? ("off" as ThinkingLevel),
        extensionRunner: { createContext: () => ({}) },
        get isStreaming() {
          return streaming;
        },
        get isCompacting() {
          return false;
        },
        subscribe: (listener: (event: FakeEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        bindExtensions: async () => undefined,
        settingsManager: { applyOverrides: () => undefined },
        reload: async () => undefined,
        dispose: () => {
          entry.disposed = true;
        },
        getActiveToolNames: () => [],
        setActiveToolsByName: () => undefined,
        setModel: async (model: { id?: string }) => {
          session.model = model;
        },
        setThinkingLevel: (level: ThinkingLevel) => {
          session.thinkingLevel = level;
        },
        prompt: async (text: string) => {
          runTurn({ role: "user", content: text, timestamp: Date.now() }, text);
        },
        sendCustomMessage: async (
          message: unknown,
          options?: { triggerTurn?: boolean },
        ) => {
          entry.customMessages.push({ message, options });
          const content =
            message && typeof message === "object" && "content" in message
              ? (message as { content?: unknown }).content
              : "";
          const custom = message as { customType?: string; display?: boolean; details?: unknown } | null;
          const appendHistory = () => sessionManager.appendCustomMessageEntry(
            custom?.customType ?? "fixture", content, custom?.display ?? false, custom?.details,
          );
          if (options?.triggerTurn) {
            runTurn(undefined, typeof content === "string" ? content : "", appendHistory);
          } else {
            appendHistory();
          }
        },
      };
      sessions.push(entry);
      return { session };
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => fakePi);
vi.mock("@/lib/auto-agent", () => ({ resolveAutoAgent: vi.fn() }));

import {
  accountAuthPath,
  createAccount,
  __resetPiAgentDirCacheForTests,
} from "@/lib/accounts";
import { clearCachedUsage, setCachedUsage } from "@/lib/codexbar/cache";
import { parseCodexBarSnapshot } from "@/lib/codexbar";
import { getTask, upsertProject } from "@/lib/store";
import { setProviderModelDefaultThinkingLevel } from "@/lib/provider-model-state";
import type { ThinkingLevel } from "@/lib/types";
import {
  clearProviderLimit,
  markProviderLimited,
  setAccountRoutingMode,
  __resetProviderRoutingQueueForTests,
} from "@/lib/provider-routing";
import { getTaskHangWatch } from "./hang-watchdog";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { SdkRuntimeFactory } from "@backend-core/sdk-runtime.mjs";
import {
  createTask,
  promptTask,
  PROVIDER_FALLBACK_FAILED_MESSAGE,
  __waitForProviderFallbackIdleForTests,
} from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const MODEL_ID = "gpt-6-astra";
const tempDirs: string[] = [];
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

function runtime(accountId: string, provider: string, modelID = MODEL_ID, reasoning = false) {
  const model = {
    provider,
    id: modelID,
    input: ["text"],
    reasoning,
    thinkingLevelMap: { off: "none" },
  };
  return {
    accountId,
    getProvider: () => ({ id: provider }),
    registerProvider: () => undefined,
    getProviders: () => [{ id: provider, name: provider }],
    getModels: () => [{ id: model.id, name: model.id }],
    getModel: (providerID: string, requested: string) =>
      providerID === model.provider && requested === model.id ? { ...model } : undefined,
    hasConfiguredAuth: () => true,
    isUsingSubscription: () => true,
    getAvailable: async () => [model],
  };
}

function installHarness(runtimes: Map<string, ReturnType<typeof runtime>>) {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    pi: fakePi,
    modelRuntime: {
      getProvider: (id: string) => ({ id }),
      getModel: () => undefined,
      registerProvider: () => undefined,
    },
    accountRuntimes: new AccountRuntimeManager(
      async (accountId) => runtimes.get(accountId) as never,
    ),
    initPromise: null,
    initError: null,
    live: new Map(),
    events: new EventEmitter(),
    healthCache: null,
    modelCache: null,
    modelInflight: null,
    accountModelCache: null,
    accountModelInflight: null,
    watchdogRegistered: true,
    lastProviderSyncWarnings: [],
  };
}

function storeProviderAuth(accountId: string, agentDir: string, provider: string): void {
  const path = accountAuthPath(accountId, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      [provider]: { type: "oauth", access: "t", refresh: "r", expires: 1 },
    }),
    "utf8",
  );
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("waiting for the expected state timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(async () => {
  // A usage-limit fallback can still be replacing the session; drain it while
  // this test's data dir and fake runtime are still installed.
  await __waitForProviderFallbackIdleForTests();
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  clearCachedUsage();
  __resetProviderRoutingQueueForTests();
  __resetPiAgentDirCacheForTests();
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  fakePi.reset();
  vi.restoreAllMocks();
});

describe.each(["openai-codex", "openai"] as const)("provider limit fallback: %s", (PROVIDER) => {
  it("moves an integrated task to another account after a usage limit", async () => {
    const factorySession = vi.spyOn(SdkRuntimeFactory.prototype, "createAgentSession");
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-limit-fallback-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const first = createAccount({ label: "codex-1", providers: [PROVIDER] });
    const second = createAccount({ label: "codex-2", providers: [PROVIDER] });
    storeProviderAuth(first.id, agentDir, PROVIDER);
    storeProviderAuth(second.id, agentDir, PROVIDER);
    installHarness(
      new Map([
        [first.id, runtime(first.id, PROVIDER)],
        [second.id, runtime(second.id, PROVIDER)],
      ]),
    );
    await setAccountRoutingMode(PROVIDER, "integrated");
    // New ChatGPT OAuth has no legacy Codex usage endpoint: exercise unknown usage.
    if (PROVIDER === "openai-codex") setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: PROVIDER, accountId: first.id, usedPercent: 10 },
          { codexBarProviderId: PROVIDER, accountId: second.id, usedPercent: 40 },
        ],
      }),
    );

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: `${PROVIDER}::${MODEL_ID}`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, first.id);
    assert.equal(fakePi.sessions.length, 1);
    expect(factorySession).toHaveBeenCalledTimes(1);
    expect(factorySession.mock.calls[0][0]).toMatchObject({
      cwd: dir,
      modelRuntime: { accountId: first.id },
    });

    fakePi.sessions[0].nextError = PROVIDER === "openai"
      ? "OpenAI API error: subscription_sharing_usage_limit_exceeded"
      : "You have hit your ChatGPT usage limit (team plan). Try again in ~286 min.";
    // Unknown usage can rebalance before the turn; pin the failing account so
    // this exercises error recovery rather than ordinary load balancing.
    await promptTask(task.id, "continue working", undefined, PROVIDER === "openai"
      ? { model: `${first.id}::${PROVIDER}::${MODEL_ID}` }
      : undefined);

    await waitFor(() => fakePi.sessions.length === 2);
    expect(fakePi.sessions[1]).toMatchObject({ accountId: second.id });
    expect(factorySession).toHaveBeenCalledTimes(2);
    expect(factorySession.mock.calls[1][0]).toMatchObject({
      cwd: dir,
      modelRuntime: { accountId: second.id },
    });
    assert.equal(getTask(task.id)?.accountId, second.id);
    await waitFor(() => fakePi.sessions[1]?.prompts.length === 1);
    expect(getTaskHangWatch(task.id)).toBeNull();
    expect(fakePi.sessions[1]?.customMessages).toMatchObject([
      {
        message: {
          customType: "leafcode-pi.provider-fallback",
          content: expect.stringMatching(
            /<host_clock>[\s\S]+<\/host_clock>\n\nThe previous response was interrupted by a provider usage limit\./,
          ),
          display: false,
        },
        options: { triggerTurn: true },
      },
    ]);
    expect(fakePi.sessions[1]?.history).toEqual([
      expect.objectContaining({ role: "user", content: "start" }),
      expect.objectContaining({ role: "user", content: "continue working" }),
      expect.objectContaining({ role: "custom", customType: "leafcode-pi.provider-fallback", display: false }),
    ]);
    assert.equal(fakePi.sessions[0]?.prompts.length, 2);
    assert.equal(getTask(task.id)?.status, "idle");
  });

  it.each([
    { destinationDefault: undefined, accountSpecific: false, sameModel: false },
    { destinationDefault: "low", accountSpecific: false, sameModel: false },
    { destinationDefault: "low", accountSpecific: true, sameModel: false },
    { destinationDefault: "low", accountSpecific: true, sameModel: true },
  ] as const)("resolves destination effort on fallback (%j)", async ({ destinationDefault, accountSpecific, sameModel }) => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-fallback-effort-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();
    const source = createAccount({ label: "source", providers: [PROVIDER] });
    const destinationProvider = sameModel ? PROVIDER : "anthropic";
    const destinationModel = sameModel ? MODEL_ID : "claude-sonnet";
    const destination = createAccount({ label: "destination", providers: [destinationProvider] });
    storeProviderAuth(source.id, agentDir, PROVIDER);
    storeProviderAuth(destination.id, agentDir, destinationProvider);
    installHarness(new Map([
      [source.id, runtime(source.id, PROVIDER, MODEL_ID, true)],
      [destination.id, runtime(destination.id, destinationProvider, destinationModel, true)],
    ]));
    await setAccountRoutingMode(PROVIDER, "integrated");
    await setAccountRoutingMode("anthropic", "integrated");
    if (destinationDefault) {
      await setProviderModelDefaultThinkingLevel(destinationProvider, destinationModel, destinationDefault, accountSpecific ? destination.id : undefined);
    }
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({ projectId: project.id, prompt: "start", model: `${PROVIDER}::${MODEL_ID}`, thinkingLevel: "high" });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.thinkingLevel, "high");
    fakePi.sessions[0]?.emit?.({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }] });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });
    await waitFor(() => fakePi.sessions[1]?.prompts.length === 1);
    assert.equal(getTask(task.id)?.providerID, destinationProvider);
    assert.equal(getTask(task.id)?.accountId, destination.id);
    assert.equal(getTask(task.id)?.thinkingLevel, sameModel ? "high" : destinationDefault ?? "high");
  });

  it("crosses to another provider when every account of this provider is maxed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-limit-cross-provider-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const codex = createAccount({ label: "codex", providers: [PROVIDER] });
    const claude = createAccount({ label: "claude", providers: ["anthropic"] });
    storeProviderAuth(codex.id, agentDir, PROVIDER);
    storeProviderAuth(claude.id, agentDir, "anthropic");
    installHarness(
      new Map([
        [codex.id, runtime(codex.id, PROVIDER)],
        [claude.id, runtime(claude.id, "anthropic", "claude-sonnet")],
      ]),
    );
    await setAccountRoutingMode(PROVIDER, "integrated");
    await setAccountRoutingMode("anthropic", "integrated");
    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: PROVIDER, accountId: codex.id, usedPercent: 20 },
          { codexBarProviderId: "anthropic", accountId: claude.id, usedPercent: 5 },
        ],
      }),
    );

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: `${PROVIDER}::${MODEL_ID}`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, codex.id);

    fakePi.sessions[0]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "assistant", errorMessage: "Codex error: The usage limit has been reached" },
      ],
    });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });

    await waitFor(() => fakePi.sessions.length === 2);
    expect(fakePi.sessions[1]).toMatchObject({
      accountId: claude.id,
      modelID: "claude-sonnet",
    });
    assert.equal(getTask(task.id)?.providerID, "anthropic");
    await waitFor(() => fakePi.sessions[1]?.prompts.length === 1);

    // Exhausting the replacement must not cycle back to the first account.
    fakePi.sessions[1]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }],
    });
    fakePi.sessions[1]?.emit?.({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fakePi.sessions.length, 2);
    assert.equal(fakePi.sessions[1]?.prompts.length, 1);
  });

  it("REPRO: a separate-mode account still falls back after a limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-limit-separate-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const claude = createAccount({ label: "claude", providers: ["anthropic"] });
    const claudeOther = createAccount({ label: "claude-2", providers: ["anthropic"] });
    const codex = createAccount({ label: "codex", providers: [PROVIDER] });
    storeProviderAuth(claude.id, agentDir, "anthropic");
    storeProviderAuth(claudeOther.id, agentDir, "anthropic");
    storeProviderAuth(codex.id, agentDir, PROVIDER);
    installHarness(
      new Map([
        [claude.id, runtime(claude.id, "anthropic", "claude-sonnet")],
        [claudeOther.id, runtime(claudeOther.id, "anthropic", "claude-sonnet")],
        [codex.id, runtime(codex.id, PROVIDER)],
      ]),
    );
    // Separate mode keeps the anthropic accounts as distinct picker rows.
    await setAccountRoutingMode("anthropic", "separate");
    await setAccountRoutingMode(PROVIDER, "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      // An explicitly selected account is still recovered from an exhausted route.
      model: `${claude.id}::anthropic::claude-sonnet`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, claude.id);
    assert.equal(getTask(task.id)?.accountIdExplicit, true);

    fakePi.sessions[0]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }],
    });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });

    await waitFor(() => fakePi.sessions.length === 2);
    // The other account of the same provider comes before crossing providers.
    expect(fakePi.sessions[1]).toMatchObject({ accountId: claudeOther.id });
    assert.equal(getTask(task.id)?.accountId, claudeOther.id);
    assert.notEqual(getTask(task.id)?.providerID, PROVIDER);
    // Limit recovery must drop the pin so later integrated rebalancing can run.
    assert.equal(getTask(task.id)?.accountIdExplicit, undefined);
    await waitFor(() => fakePi.sessions[1]?.prompts.length === 1);

    fakePi.sessions[1]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }],
    });
    fakePi.sessions[1]?.emit?.({ type: "agent_settled" });
    await waitFor(() => fakePi.sessions[2]?.prompts.length === 1);
    assert.equal(getTask(task.id)?.accountId, codex.id);
    assert.equal(getTask(task.id)?.accountIdExplicit, undefined);
  });

  it("reports an actionable error when the limit leaves no fallback route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-limit-no-route-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const only = createAccount({ label: "codex-only", providers: [PROVIDER] });
    storeProviderAuth(only.id, agentDir, PROVIDER);
    installHarness(new Map([[only.id, runtime(only.id, PROVIDER)]]));
    await setAccountRoutingMode(PROVIDER, "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: `${PROVIDER}::${MODEL_ID}`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, only.id);

    fakePi.sessions[0].nextError = PROVIDER === "openai"
      ? "OpenAI API error: subscription_sharing_usage_limit_exceeded"
      : "You have hit your ChatGPT usage limit (team plan). Try again in ~286 min.";
    await promptTask(task.id, "continue working");

    // The single exhausted route has no destination. The task must say so
    // instead of leaving the raw provider error with no visible recovery.
    await waitFor(
      () => getTask(task.id)?.error === PROVIDER_FALLBACK_FAILED_MESSAGE,
      15_000,
    );
    assert.equal(fakePi.sessions.length, 1);
    assert.equal(fakePi.sessions[0]?.customMessages.length, 0);
  }, 20_000);

  it("retries until a fallback route becomes available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-limit-retry-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const first = createAccount({ label: "codex-1", providers: [PROVIDER] });
    const second = createAccount({ label: "codex-2", providers: [PROVIDER] });
    storeProviderAuth(first.id, agentDir, PROVIDER);
    storeProviderAuth(second.id, agentDir, PROVIDER);
    installHarness(
      new Map([
        [first.id, runtime(first.id, PROVIDER)],
        [second.id, runtime(second.id, PROVIDER)],
      ]),
    );
    await setAccountRoutingMode(PROVIDER, "integrated");
    // The sibling route is unusable for the first attempt. A later retry must
    // pick it up instead of leaving the task in error.
    markProviderLimited(PROVIDER, second.id);

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: `${PROVIDER}::${MODEL_ID}`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, first.id);

    fakePi.sessions[0].nextError = PROVIDER === "openai"
      ? "OpenAI API error: subscription_sharing_usage_limit_exceeded"
      : "You have hit your ChatGPT usage limit (team plan). Try again in ~286 min.";
    await promptTask(task.id, "continue working", undefined, {
      model: `${first.id}::${PROVIDER}::${MODEL_ID}`,
    });
    // Free the sibling after the first attempt has failed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    clearProviderLimit(PROVIDER, second.id);

    await waitFor(() => fakePi.sessions.length === 2, 15_000);
    expect(fakePi.sessions[1]).toMatchObject({ accountId: second.id });
    assert.equal(getTask(task.id)?.accountId, second.id);
    await waitFor(() => fakePi.sessions[1]?.prompts.length === 1);
  }, 20_000);
});

// A queued prompt marks its task working before the integrated route is
// re-resolved. The task must not count against its own account in that ranking,
// or every re-route prefers another account and abandons the limit fallback.
describe.each(["openai-codex", "openai"] as const)("integrated routing load count: %s", (PROVIDER) => {
  it("keeps a later prompt on the current account when usage is unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-self-load-route-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const first = createAccount({ label: "codex-1", providers: [PROVIDER] });
    const second = createAccount({ label: "codex-2", providers: [PROVIDER] });
    const third = createAccount({ label: "codex-3", providers: [PROVIDER] });
    for (const account of [first, second, third]) {
      storeProviderAuth(account.id, agentDir, PROVIDER);
    }
    installHarness(
      new Map([
        [first.id, runtime(first.id, PROVIDER)],
        [second.id, runtime(second.id, PROVIDER)],
        [third.id, runtime(third.id, PROVIDER)],
      ]),
    );
    await setAccountRoutingMode(PROVIDER, "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: `${PROVIDER}::${MODEL_ID}`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, first.id);
    assert.equal(fakePi.sessions.length, 1);

    await promptTask(task.id, "second prompt");
    await waitFor(() => getTask(task.id)?.status === "idle");

    assert.equal(getTask(task.id)?.accountId, first.id);
    assert.equal(fakePi.sessions.length, 1, "the same account must keep the session");
    expect(fakePi.sessions[0]?.prompts).toEqual(["start", "second prompt"]);
  });

  it("keeps the fallback account on the hidden resume prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-fallback-resume-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const first = createAccount({ label: "codex-1", providers: [PROVIDER] });
    const second = createAccount({ label: "codex-2", providers: [PROVIDER] });
    const third = createAccount({ label: "codex-3", providers: [PROVIDER] });
    for (const account of [first, second, third]) {
      storeProviderAuth(account.id, agentDir, PROVIDER);
    }
    installHarness(
      new Map([
        [first.id, runtime(first.id, PROVIDER)],
        [second.id, runtime(second.id, PROVIDER)],
        [third.id, runtime(third.id, PROVIDER)],
      ]),
    );
    await setAccountRoutingMode(PROVIDER, "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: `${PROVIDER}::${MODEL_ID}`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, first.id);

    fakePi.sessions[0].nextError = PROVIDER === "openai"
      ? "OpenAI API error: subscription_sharing_usage_limit_exceeded"
      : "You have hit your ChatGPT usage limit (team plan). Try again in ~286 min.";
    // Pin the failing account so the turn reaches the limit on the account under
    // test instead of being rebalanced before it starts.
    await promptTask(task.id, "continue working", undefined, {
      model: `${first.id}::${PROVIDER}::${MODEL_ID}`,
    });

    await waitFor(() => fakePi.sessions.length === 2 && fakePi.sessions[1]?.prompts.length === 1);
    expect(fakePi.sessions[1]).toMatchObject({ accountId: second.id });
    assert.equal(getTask(task.id)?.accountId, second.id);
  });
});

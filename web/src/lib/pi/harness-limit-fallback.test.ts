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
    disposed: boolean;
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
    }) => {
      const sessionManager = options.sessionManager;
      const entry = {
        accountId: options.modelRuntime?.accountId ?? null,
        modelID: options.model?.id ?? null,
        file: sessionManager.__file,
        prompts: [] as string[],
        disposed: false,
        emit: undefined as ((event: FakeEvent) => void) | undefined,
      };
      const listeners = new Set<(event: FakeEvent) => void>();
      const emit = (event: FakeEvent) => {
        for (const listener of listeners) listener(event);
      };
      entry.emit = emit;
      let streaming = false;
      const session = {
        sessionFile: sessionManager.__file,
        sessionId: sessionManager.__sessionId,
        sessionManager,
        messages: sessionManager.history,
        agent: { state: { errorMessage: undefined, streamingMessage: undefined } },
        model: options.model,
        thinkingLevel: "off" as ThinkingLevel,
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
          streaming = true;
          emit({ type: "agent_start" });
          entry.prompts.push(text);
          sessionManager.history.push({ role: "user", content: text, timestamp: Date.now() });
          streaming = false;
          emit({ type: "agent_end", willRetry: false, messages: [] });
          emit({ type: "agent_settled" });
        },
        sendCustomMessage: async () => undefined,
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
import type { ThinkingLevel } from "@/lib/types";
import {
  setAccountRoutingMode,
  __resetProviderRoutingQueueForTests,
} from "@/lib/provider-routing";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { createTask } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-6-astra";
const tempDirs: string[] = [];
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

function runtime(accountId: string, provider = PROVIDER, modelID = MODEL_ID) {
  const model = {
    provider,
    id: modelID,
    input: ["text"],
    reasoning: false,
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

function storeProviderAuth(accountId: string, agentDir: string, provider = PROVIDER): void {
  const path = accountAuthPath(accountId, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ [provider]: { type: "oauth", access: "t" } }), "utf8");
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("waiting for the expected state timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
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
});

describe("provider limit fallback", () => {
  it("moves an integrated task to another account after a usage limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-limit-fallback-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const first = createAccount({ label: "codex-1", providers: [PROVIDER] });
    const second = createAccount({ label: "codex-2", providers: [PROVIDER] });
    storeProviderAuth(first.id, agentDir);
    storeProviderAuth(second.id, agentDir);
    installHarness(
      new Map([
        [first.id, runtime(first.id)],
        [second.id, runtime(second.id)],
      ]),
    );
    await setAccountRoutingMode(PROVIDER, "integrated");
    setCachedUsage(
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

    fakePi.sessions[0]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "assistant", errorMessage: "Codex error: The usage limit has been reached" },
      ],
    });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });

    await waitFor(() => fakePi.sessions.length === 2);
    expect(fakePi.sessions[1]).toMatchObject({ accountId: second.id });
    assert.equal(getTask(task.id)?.accountId, second.id);
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
    storeProviderAuth(codex.id, agentDir);
    storeProviderAuth(claude.id, agentDir, "anthropic");
    installHarness(
      new Map([
        [codex.id, runtime(codex.id)],
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
  });

  it("REPRO: a separate-mode account still crosses to another provider", async () => {
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
    storeProviderAuth(codex.id, agentDir);
    installHarness(
      new Map([
        [claude.id, runtime(claude.id, "anthropic", "claude-sonnet")],
        [claudeOther.id, runtime(claudeOther.id, "anthropic", "claude-sonnet")],
        [codex.id, runtime(codex.id)],
      ]),
    );
    // Separate mode keeps the anthropic accounts as distinct picker rows.
    await setAccountRoutingMode("anthropic", "separate");
    await setAccountRoutingMode(PROVIDER, "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "start",
      model: "anthropic::claude-sonnet",
      accountId: claude.id,
      accountIdExplicit: false,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, claude.id);

    fakePi.sessions[0]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }],
    });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });

    await waitFor(() => fakePi.sessions.length === 2);
    // Never account-hops inside a separate-mode provider, but leaves the dead route.
    expect(fakePi.sessions[1]).toMatchObject({ accountId: codex.id, modelID: MODEL_ID });
    assert.equal(getTask(task.id)?.providerID, PROVIDER);
  });
});

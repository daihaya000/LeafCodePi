import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakePi = vi.hoisted(() => {
  const histories = new Map<string, unknown[]>();
  const sessions: {
    accountId: string | null;
    file: string;
    prompts: string[];
    disposed: boolean;
  }[] = [];

  function manager(cwd: string, file: string) {
    let name: string | undefined;
    const history = histories.get(file) ?? [];
    histories.set(file, history);
    return {
      __file: file,
      getSessionName: () => name,
      appendSessionInfo: (next: string) => {
        name = next;
      },
      getCwd: () => cwd,
      getEntries: () => [],
      getLeafId: () => null,
      getBranch: () => [],
      appendCustomEntry: () => undefined,
      history,
    };
  }

  return {
    sessions,
    getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? "",
    DefaultResourceLoader: class {
      constructor(...args: unknown[]) {
        void args;
      }
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
      model?: unknown;
      modelRuntime?: { accountId?: string };
    }) => {
      const manager = options.sessionManager;
      const entry = {
        accountId: options.modelRuntime?.accountId ?? null,
        file: manager.__file,
        prompts: [] as string[],
        disposed: false,
      };
      const listeners = new Set<(event: { type: string; willRetry?: boolean }) => void>();
      let streaming = false;
      const session = {
        sessionFile: manager.__file,
        sessionId: `session-${sessions.length + 1}`,
        sessionManager: manager,
        messages: manager.history,
        agent: { state: { errorMessage: undefined, streamingMessage: undefined } },
        model: options.model,
        thinkingLevel: "off" as const,
        extensionRunner: { createContext: () => ({}) },
        get isStreaming() {
          return streaming;
        },
        get isCompacting() {
          return false;
        },
        subscribe: (listener: (event: { type: string; willRetry?: boolean }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        bindExtensions: async () => undefined,
        dispose: () => {
          entry.disposed = true;
        },
        getActiveToolNames: () => [],
        setActiveToolsByName: () => undefined,
        setThinkingLevel: (level: "off") => {
          session.thinkingLevel = level;
        },
        prompt: async (text: string) => {
          streaming = true;
          for (const listener of listeners) listener({ type: "agent_start" });
          entry.prompts.push(text);
          manager.history.push({ role: "user", content: text, timestamp: Date.now() });
          streaming = false;
          for (const listener of listeners) {
            listener({ type: "agent_end", willRetry: false });
            listener({ type: "agent_settled" });
          }
        },
      };
      sessions.push(entry);
      return { session };
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => fakePi);

import { createAccount, accountAuthPath, __resetPiAgentDirCacheForTests } from "@/lib/accounts";
import { clearCachedUsage, setCachedUsage } from "@/lib/codexbar/cache";
import { parseCodexBarSnapshot } from "@/lib/codexbar";
import { upsertProject, getTask } from "@/lib/store";
import { setAccountRoutingMode, __resetProviderRoutingQueueForTests } from "@/lib/provider-routing";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { createTask, promptTask } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const tempDirs: string[] = [];
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

function runtime(accountId: string) {
  const model = {
    provider: "anthropic",
    id: "claude-sonnet",
    input: ["text"],
    reasoning: false,
    thinkingLevelMap: { off: "none" },
  };
  return {
    accountId,
    getProvider: () => ({ id: "anthropic" }),
    registerProvider: () => undefined,
    getProviders: () => [{ id: "anthropic", name: "Anthropic" }],
    getModels: () => [{ id: model.id, name: "Claude Sonnet" }],
    getModel: (providerID: string, modelID: string) =>
      providerID === model.provider && modelID === model.id ? { ...model } : undefined,
    hasConfiguredAuth: () => true,
    getAvailable: async () => [model],
  };
}

function installHarness(runtimes: Map<string, ReturnType<typeof runtime>>) {
  const defaultRuntime = {
    getProvider: (id: string) => ({ id }),
    registerProvider: () => undefined,
  };
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    pi: fakePi,
    modelRuntime: defaultRuntime,
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

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("テスト状態の待機がタイムアウトしました");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function storeProviderAuth(accountId: string, agentDir: string): void {
  const path = accountAuthPath(accountId, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), "utf8");
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
  fakePi.sessions.length = 0;
});

describe("integrated session routing", () => {
  it("reselects an account before a later prompt and keeps the transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-session-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();
    writeFileSync(join(dir, "collaboration.json"), JSON.stringify({ mode: "off" }), "utf8");

    const high = createAccount({ label: "使用量大", providers: ["anthropic"] });
    const low = createAccount({ label: "使用量小", providers: ["anthropic"] });
    storeProviderAuth(high.id, agentDir);
    storeProviderAuth(low.id, agentDir);
    const runtimes = new Map([
      [high.id, runtime(high.id)],
      [low.id, runtime(low.id)],
    ]);
    installHarness(runtimes);
    await setAccountRoutingMode("anthropic", "integrated");
    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: "anthropic", accountId: high.id, usedPercent: 20 },
          { codexBarProviderId: "anthropic", accountId: low.id, usedPercent: 80 },
        ],
      }),
    );

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "最初の確認",
      model: "anthropic::claude-sonnet",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, high.id);
    assert.equal(fakePi.sessions.length, 1);

    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: "anthropic", accountId: high.id, usedPercent: 80 },
          { codexBarProviderId: "anthropic", accountId: low.id, usedPercent: 20 },
        ],
      }),
    );
    await promptTask(task.id, "次の確認");
    await waitFor(() => getTask(task.id)?.accountId === low.id && fakePi.sessions.length === 2);

    expect(fakePi.sessions[0]).toMatchObject({ accountId: high.id, file: fakePi.sessions[1]?.file, disposed: true });
    expect(fakePi.sessions[1]).toMatchObject({ accountId: low.id });
    expect(fakePi.sessions[1]?.prompts).toEqual(["次の確認"]);
    assert.equal(getTask(task.id)?.accountId, low.id);
  });
});

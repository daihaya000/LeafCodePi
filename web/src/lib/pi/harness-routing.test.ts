import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakePi = vi.hoisted(() => {
  type FakeEvent = {
    type: string;
    willRetry?: boolean;
    messages?: unknown[];
  };
  const histories = new Map<string, unknown[]>();
  const sessions: {
    accountId: string | null;
    file: string;
    prompts: string[];
    events: string[];
    reloads: number;
    disposed: boolean;
    emit?: (event: FakeEvent) => void;
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
      const entry: {
        accountId: string | null;
        file: string;
        prompts: string[];
        events: string[];
        reloads: number;
        disposed: boolean;
        emit?: (event: FakeEvent) => void;
      } = {
        accountId: options.modelRuntime?.accountId ?? null,
        file: manager.__file,
        prompts: [] as string[],
        events: [] as string[],
        reloads: 0,
        disposed: false,
      };
      const listeners = new Set<(event: FakeEvent) => void>();
      const emit = (event: FakeEvent) => {
        for (const listener of listeners) listener(event);
      };
      entry.emit = emit;
      let streaming = false;
      const session = {
        sessionFile: manager.__file,
        sessionId: `session-${sessions.length + 1}`,
        sessionManager: manager,
        messages: manager.history,
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
        reload: async () => {
          entry.reloads += 1;
          entry.events.push("reload");
        },
        dispose: () => {
          entry.disposed = true;
        },
        getActiveToolNames: () => [],
        setActiveToolsByName: () => undefined,
        setModel: async (model: unknown) => {
          session.model = model;
        },
        setThinkingLevel: (level: ThinkingLevel) => {
          session.thinkingLevel = level;
        },
        prompt: async (text: string) => {
          entry.events.push("prompt");
          streaming = true;
          emit({ type: "agent_start" });
          entry.prompts.push(text);
          manager.history.push({ role: "user", content: text, timestamp: Date.now() });
          streaming = false;
          emit({ type: "agent_end", willRetry: false });
          emit({ type: "agent_settled" });
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
import type { ThinkingLevel } from "@/lib/types";
import { setAccountRoutingMode, __resetProviderRoutingQueueForTests, markProviderLimited } from "@/lib/provider-routing";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { createTask, promptTask, resolveProviderFallbackModels } from "./harness";

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
  it("applies prompt permissions before queueing and persists them on the task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-prompt-permissions-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({ projectId: project.id, prompt: "最初の確認" });
    await waitFor(() => getTask(task.id)?.status === "idle");
    const session = fakePi.sessions[0]!;

    await promptTask(task.id, "権限付きで続行", undefined, {
      permissionMode: "deny",
      skillPermission: "deny",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");

    assert.equal(getTask(task.id)?.permissionMode, "deny");
    assert.equal(getTask(task.id)?.skillPermission, "deny");
    assert.equal(session.reloads, 1);
    assert.deepEqual(session.events, ["prompt", "reload", "prompt"]);
  });

  it("applies Composer effort instead of the directly selected agent's subagent default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auto-agent-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "build.md"),
      "---\nname: build\nmodel: anthropic/claude-sonnet\n---\n",
      "utf8",
    );

    const account = createAccount({ label: "テスト", providers: ["anthropic"] });
    storeProviderAuth(account.id, agentDir);
    installHarness(new Map([[account.id, runtime(account.id)]]));
    await setAccountRoutingMode("anthropic", "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "最初の確認",
      model: "anthropic::claude-sonnet",
      thinkingLevel: "off",
      agent: "build",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");

    await promptTask(task.id, "Composer設定で続行", undefined, {
      model: "anthropic::claude-sonnet",
      thinkingLevel: "medium",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");

    assert.equal(getTask(task.id)?.thinkingLevel, "medium");
  });

  it("applies an Auto-resolved model and effort over the agent's subagent default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auto-route-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "build.md"),
      "---\nname: build\nmodel: anthropic/claude-sonnet\nthinking: max\n---\n",
      "utf8",
    );

    const account = createAccount({ label: "テスト", providers: ["anthropic"] });
    storeProviderAuth(account.id, agentDir);
    installHarness(new Map([[account.id, runtime(account.id)]]));
    await setAccountRoutingMode("anthropic", "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "最初の確認",
      model: "anthropic::claude-sonnet",
      thinkingLevel: "off",
      agent: "build",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");

    // Autoが解決したmodel/effortは、エージェントのサブエージェント既定値に上書きされない。
    await promptTask(task.id, "Autoで続行", undefined, {
      model: "anthropic::claude-sonnet",
      thinkingLevel: "low",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");

    assert.equal(getTask(task.id)?.thinkingLevel, "low");
  });

  it("reselects an account before a later prompt and keeps the transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-session-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

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

    await promptTask(task.id, "Auto指定アカウントで続行", undefined, {
      model: `${high.id}::anthropic::claude-sonnet`,
      accountIdExplicit: false,
    });
    await waitFor(() => getTask(task.id)?.accountId === high.id && fakePi.sessions.length === 3);
    expect(fakePi.sessions[2]).toMatchObject({ accountId: high.id });
  });

  it("keeps an explicitly selected account for later prompts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-explicit-account-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const first = createAccount({ label: "固定アカウント", providers: ["anthropic"] });
    const other = createAccount({ label: "別アカウント", providers: ["anthropic"] });
    storeProviderAuth(first.id, agentDir);
    storeProviderAuth(other.id, agentDir);
    installHarness(new Map([[first.id, runtime(first.id)], [other.id, runtime(other.id)]]));
    await setAccountRoutingMode("anthropic", "integrated");
    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: "anthropic", accountId: first.id, usedPercent: 80 },
          { codexBarProviderId: "anthropic", accountId: other.id, usedPercent: 20 },
        ],
      }),
    );

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "固定して開始",
      model: `${first.id}::anthropic::claude-sonnet`,
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, first.id);
    assert.equal(getTask(task.id)?.accountIdExplicit, true);
    assert.equal(fakePi.sessions.length, 1);

    await promptTask(task.id, "固定したまま続行");
    await waitFor(() => getTask(task.id)?.status === "idle");

    assert.equal(fakePi.sessions.length, 1);
    expect(fakePi.sessions[0]?.prompts).toEqual(["固定して開始", "固定したまま続行"]);
    assert.equal(getTask(task.id)?.accountId, first.id);

    // 明示アカウントのリミットでも別アカウントへ自動フォールバックしない。
    fakePi.sessions[0]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }],
    });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fakePi.sessions.length, 1);
    assert.equal(getTask(task.id)?.accountId, first.id);
  });

  it("crosses to another provider at the next turn after a limit response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-provider-fallback-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const claude = createAccount({ label: "Claude", providers: ["anthropic"] });
    const codex = createAccount({ label: "Codex", providers: ["openai-codex"] });
    storeProviderAuth(claude.id, agentDir);
    const codexAuthPath = accountAuthPath(codex.id, agentDir);
    mkdirSync(dirname(codexAuthPath), { recursive: true });
    writeFileSync(
      codexAuthPath,
      JSON.stringify({ "openai-codex": { type: "api_key", key: "test-key" } }),
      "utf8",
    );
    const codexModel = {
      provider: "openai-codex",
      id: "codex-model",
      input: ["text"],
      reasoning: false,
      thinkingLevelMap: { off: "none" },
    };
    const codexRuntime = (accountId: string) => ({
      accountId,
      getProvider: () => ({ id: "openai-codex" }),
      registerProvider: () => undefined,
      getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
      getModels: () => [{ id: codexModel.id, name: "Codex" }],
      getModel: (providerID: string, modelID: string) =>
        providerID === codexModel.provider && modelID === codexModel.id
          ? { ...codexModel }
          : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: async () => [codexModel],
    });
    installHarness(
      new Map([
        [claude.id, runtime(claude.id)],
        [codex.id, codexRuntime(codex.id)],
      ]),
    );
    await setAccountRoutingMode("anthropic", "integrated");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "最初の確認",
      model: "anthropic::claude-sonnet",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, claude.id);
    assert.equal(fakePi.sessions.length, 1);

    // リミット応答を模して、同一プロバイダーを除外した上で別プロバイダーへ切り替える。
    markProviderLimited("anthropic", claude.id);

    const fallbacks = await resolveProviderFallbackModels({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    assert.deepEqual(
      fallbacks.map((model) => model.providerID),
      ["openai-codex"],
    );

    await promptTask(task.id, "次の確認");
    await waitFor(
      () =>
        getTask(task.id)?.accountId === codex.id &&
        fakePi.sessions.length === 2,
    );

    assert.equal(fakePi.sessions.length, 2);
    expect(fakePi.sessions[0]).toMatchObject({ accountId: claude.id, disposed: true });
    expect(fakePi.sessions[1]).toMatchObject({ accountId: codex.id });
    expect(fakePi.sessions[1]?.prompts).toEqual(["次の確認"]);
    assert.equal(getTask(task.id)?.accountId, codex.id);
    assert.equal(getTask(task.id)?.providerID, "openai-codex");
    assert.equal(getTask(task.id)?.modelID, "codex-model");
  });
});

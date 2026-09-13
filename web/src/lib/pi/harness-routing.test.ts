import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakePi = vi.hoisted(() => {
  type FakeEvent = {
    type: string;
    willRetry?: boolean;
    messages?: unknown[];
    prompt?: string;
    systemPrompt?: string;
  };
  type FakeExtensionHandler = (event: unknown, ctx: Record<string, unknown>) => unknown;
  type FakeExtensionApi = {
    on: (name: string, handler: FakeExtensionHandler) => void;
    registerTool: (...args: unknown[]) => void;
    getActiveTools: () => string[];
    setActiveTools: (names: string[]) => void;
  };
  type FakeInlineExtension = (pi: FakeExtensionApi) => void | Promise<void>;
  const histories = new Map<string, unknown[]>();
  const sessionIds = new Map<string, string>();
  const sessions: {
    accountId: string | null;
    file: string;
    prompts: string[];
    systemPrompts: string[];
    events: string[];
    reloads: number;
    disposed: boolean;
    initialMessageCount: number;
    customMessages: unknown[];
    compactionEnabledHistory: boolean[];
    routingContext?: Record<string, unknown>;
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
      getSessionFile: () => file,
      getHeader: () => ({ type: "session", id: sessionId, cwd }),
      getEntries: () => [],
      setSessionFile: () => undefined,
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
      extensionFactories: FakeInlineExtension[];
      constructor(options: { extensionFactories?: FakeInlineExtension[] }) {
        this.extensionFactories = options.extensionFactories ?? [];
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
      resourceLoader?: { extensionFactories?: FakeInlineExtension[] };
    }) => {
      const manager = options.sessionManager;
      const entry: {
        accountId: string | null;
        file: string;
        prompts: string[];
        systemPrompts: string[];
        events: string[];
        reloads: number;
        disposed: boolean;
        initialMessageCount: number;
        customMessages: unknown[];
        compactionEnabledHistory: boolean[];
        routingContext?: Record<string, unknown>;
        emit?: (event: FakeEvent) => void;
      } = {
        accountId: options.modelRuntime?.accountId ?? null,
        file: manager.__file,
        prompts: [] as string[],
        systemPrompts: [] as string[],
        events: [] as string[],
        reloads: 0,
        disposed: false,
        initialMessageCount: manager.history.length,
        customMessages: [],
        compactionEnabledHistory: [],
      };
      const listeners = new Set<(event: FakeEvent) => void>();
      const emit = (event: FakeEvent) => {
        for (const listener of listeners) listener(event);
      };
      entry.emit = emit;
      let streaming = false;
      const extensionHandlers = new Map<string, FakeExtensionHandler[]>();
      let activeTools: string[] = [];
      const extensionApi: FakeExtensionApi = {
        on: (name, handler) => {
          extensionHandlers.set(name, [
            ...(extensionHandlers.get(name) ?? []),
            handler,
          ]);
        },
        registerTool: () => undefined,
        getActiveTools: () => activeTools,
        setActiveTools: (names) => {
          activeTools = names;
        },
      };
      const extensionContext = {
        cwd: manager.getCwd(),
        sessionManager: manager,
      };
      entry.routingContext = extensionContext;
      const session = {
        sessionFile: manager.__file,
        sessionId: manager.__sessionId,
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
        bindExtensions: async () => {
          for (const factory of options.resourceLoader?.extensionFactories ?? []) {
            await factory(extensionApi);
          }
          for (const handler of extensionHandlers.get("session_start") ?? []) {
            await handler({}, extensionContext);
          }
        },
        settingsManager: {
          applyOverrides: (overrides: { compaction?: { enabled?: boolean } }) => {
            if (typeof overrides.compaction?.enabled === "boolean") {
              entry.compactionEnabledHistory.push(overrides.compaction.enabled);
            }
          },
        },
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
          let systemPrompt = "base system prompt";
          for (const handler of extensionHandlers.get("before_agent_start") ?? []) {
            const result = await handler(
              { type: "before_agent_start", prompt: text, systemPrompt },
              extensionContext,
            );
            if (
              result &&
              typeof result === "object" &&
              typeof (result as { systemPrompt?: unknown }).systemPrompt === "string"
            ) {
              systemPrompt = (result as { systemPrompt: string }).systemPrompt;
            }
          }
          entry.systemPrompts.push(systemPrompt);
          entry.events.push("prompt");
          streaming = true;
          emit({ type: "agent_start" });
          entry.prompts.push(text);
          manager.history.push({ role: "user", content: text, timestamp: Date.now() });
          streaming = false;
          emit({ type: "agent_end", willRetry: false });
          emit({ type: "agent_settled" });
        },
        sendCustomMessage: async (message: unknown) => {
          entry.customMessages.push(message);
          manager.history.push({ role: "custom", content: message, timestamp: Date.now() });
        },
      };
      sessions.push(entry);
      return { session };
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => fakePi);

const autoAgentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auto-agent", () => ({ resolveAutoAgent: autoAgentMock }));

import {
  createAccount,
  accountAuthPath,
  deleteAccount,
  __resetPiAgentDirCacheForTests,
} from "@/lib/accounts";
import { clearCachedUsage, setCachedUsage } from "@/lib/codexbar/cache";
import { parseCodexBarSnapshot } from "@/lib/codexbar";
import { botTaskId, createBot, patchBot } from "@/lib/bots";
import { createRoom, ensureRoomBotTask } from "@/lib/rooms";
import { patchTask, upsertProject, getTask } from "@/lib/store";
import type { ThinkingLevel } from "@/lib/types";
import { AUTO_MODEL_VALUE } from "@/lib/auto-model";
import { setAccountRoutingMode, __resetProviderRoutingQueueForTests, markProviderLimited } from "@/lib/provider-routing";
import { setSetting } from "@/lib/pi/web-settings";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { goalLoopStateFile } from "./goal-loop-state";
import { taskRuntimeLeasePath } from "@/lib/task-runtime-lease";
import {
  createTask,
  getTaskDetail,
  mergeBundledSkills,
  promptTask,
  requestBotSoulReload,
  resolveProviderFallbackModels,
} from "./harness";

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
    getModel: () => undefined,
    getProviders: () => [],
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

function dropLiveSessions(): void {
  const current = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
    live: Map<string, { session: { dispose: () => void } }>;
  };
  for (const live of current.live.values()) live.session.dispose();
  current.live.clear();
}

afterEach(() => {
  const relay = (globalThis as Record<string, unknown>).__leafcodeBotCodeRelay as { dispose?: () => void } | undefined;
  relay?.dispose?.();
  delete (globalThis as Record<string, unknown>).__leafcodeBotCodeRelay;
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
  autoAgentMock.mockReset();
});

describe("mergeBundledSkills", () => {
  it("restores the bundled copy when Pi deduplicates an excluded ~/.agents skill", () => {
    const name = "powershell-japanese-encoding";
    const globalSkill = {
      name,
      baseDir: join(homedir(), ".agents", "skills", name),
      filePath: join(homedir(), ".agents", "skills", name, "SKILL.md"),
    };
    const bundledSkill = {
      name,
      baseDir: join(process.cwd(), "skills", name),
      filePath: join(process.cwd(), "skills", name, "SKILL.md"),
    };

    expect(mergeBundledSkills([globalSkill], [bundledSkill])).toEqual([bundledSkill]);
  });
});

describe("integrated session routing", () => {
  it("injects the runtime clock into both Code and Bot turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-runtime-clock-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const codeTask = await createTask({ projectId: null, prompt: "Codeの現在日時" });
    await waitFor(() => getTask(codeTask.id)?.status === "idle");
    const bot = createBot({ name: "時計確認Bot" });
    await promptTask(botTaskId(bot.id), "Botの現在日時", undefined, {
      waitForCompletion: true,
    });

    expect(fakePi.sessions[0]?.systemPrompts[0]).toContain("<leafcode_clock>");
    expect(fakePi.sessions[1]?.systemPrompts[0]).toContain("<leafcode_clock>");
  });

  it("reopens a Bot session before the next prompt after a SOUL update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-soul-reload-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const bot = createBot({ name: "Soul reload bot" });
    const taskId = botTaskId(bot.id);
    await promptTask(taskId, "initial", undefined, { waitForCompletion: true });
    await waitFor(() => getTask(taskId)?.status === "idle");

    const harness = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
      live: Map<string, { soulReloadPending: boolean }>;
    };
    const first = fakePi.sessions[0]!;
    harness.live.get(taskId)!.soulReloadPending = true;
    first.emit?.({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.disposed).toBe(false);

    await promptTask(taskId, "next", undefined, { waitForCompletion: true });

    expect(fakePi.sessions).toHaveLength(2);
    expect(first.disposed).toBe(true);
    expect(fakePi.sessions[1]?.prompts).toEqual(["next"]);
  });

  it("notices a SOUL edit made outside this worker before the next prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-soul-worker-reload-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const bot = createBot({ name: "Worker soul bot" });
    const taskId = botTaskId(bot.id);
    await promptTask(taskId, "initial", undefined, { waitForCompletion: true });
    const first = fakePi.sessions[0]!;
    patchBot(bot.id, { soul: "# Changed in another worker" });

    await promptTask(taskId, "next", undefined, { waitForCompletion: true });

    expect(fakePi.sessions).toHaveLength(2);
    expect(first.disposed).toBe(true);
  });

  it("marks every live conversation for the Bot when SOUL changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-soul-all-sessions-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const bot = createBot({ name: "Shared soul bot" });
    const room = createRoom({ name: "Soul room", members: [bot.id] });
    const roomTaskId = ensureRoomBotTask(room, bot);
    await promptTask(botTaskId(bot.id), "one-to-one", undefined, { waitForCompletion: true });
    await promptTask(roomTaskId, "room", undefined, { waitForCompletion: true });

    requestBotSoulReload(bot.id);

    const harness = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
      live: Map<string, { soulReloadPending: boolean }>;
    };
    expect(harness.live.get(botTaskId(bot.id))?.soulReloadPending).toBe(true);
    expect(harness.live.get(roomTaskId)?.soulReloadPending).toBe(true);
  });

  it("uses persisted Auto settings when resolving the Auto task sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auto-settings-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();

    const account = createAccount({ label: "テスト", providers: ["anthropic"] });
    storeProviderAuth(account.id, process.env.PI_CODING_AGENT_DIR!);
    installHarness(new Map([[account.id, runtime(account.id)]]));
    await setAccountRoutingMode("anthropic", "integrated");
    setSetting("auto-optimize", "intelligence");
    setSetting("auto-route-overrides", JSON.stringify({
      version: 2,
      modes: {
        intelligence: {
          standard: {
            candidates: [{ kind: "model", providerID: "anthropic", modelID: "not-enabled" }],
            fallback: "error",
          },
        },
      },
    }));

    await expect(createTask({
      projectId: null,
      prompt: "修正して",
      model: AUTO_MODEL_VALUE,
    })).rejects.toThrow("Auto で選択可能なモデルがありません");
  });

  it.each([false, true])("waitForCompletion=%s preserves acceptance versus queue completion", async (waitForCompletion) => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-prompt-completion-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({ projectId: project.id, prompt: "initial" });
    const harness = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
      live: Map<string, { promptChain: Promise<void>; session: { prompt: (text: string) => Promise<void> } }>;
    };
    const live = harness.live.get(task.id)!;
    await live.promptChain;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = live.session.prompt.bind(live.session);
    const prompt = vi.spyOn(live.session, "prompt").mockImplementation(async (text) => {
      await gate;
      await original(text);
    });
    let returned = false;
    const pending = promptTask(task.id, "next", undefined, { waitForCompletion }).then((result) => {
      returned = true;
      return result;
    });
    try {
      await waitFor(() => prompt.mock.calls.length === 1);
      expect(returned).toBe(!waitForCompletion);
      expect(getTask(task.id)?.status).toBe("working");
      expect((await getTaskDetail(task.id)).isStreaming).toBe(false);
    } finally {
      release();
    }
    const result = await pending;
    await live.promptChain;
    expect(result.status).toBe(waitForCompletion ? "idle" : "working");

    prompt.mockRejectedValueOnce(new Error("Queue failure"));
    const failed = await promptTask(task.id, "fails", undefined, { waitForCompletion: true });
    expect(failed).toMatchObject({ status: "error", error: "Queue failure" });
  });

  it("fails closed when another worker owns the task lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-lease-busy-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({ projectId: project.id, prompt: "initial" });
    const harness = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as { live: Map<string, { promptChain: Promise<void> }> };
    const live = harness.live.get(task.id)!;
    await live.promptChain;
    mkdirSync(dirname(taskRuntimeLeasePath(task.id)), { recursive: true });
    writeFileSync(taskRuntimeLeasePath(task.id), JSON.stringify({ token: "other-worker", pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now() }), "utf8");
    const before = fakePi.sessions.at(-1)?.prompts.length ?? 0;
    const result = await promptTask(task.id, "must-not-prompt", undefined, { waitForCompletion: true });
    expect(fakePi.sessions.at(-1)?.prompts.length ?? 0).toBe(before);
    expect(result.status).toBe("error");
    expect(getTask(task.id)?.status).toBe("error");
  });

  it("queues a prompt for a Bot-owned Code session held by another worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-code-lease-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const project = upsertProject({ name: "demo", rootPath: dir });
    const bot = createBot({ name: "worker" });
    const task = await createTask({ projectId: project.id, prompt: "initial", botId: bot.id });
    const live = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
      live: Map<string, { promptChain: Promise<void> }>;
    };
    await live.live.get(task.id)!.promptChain;
    patchTask(task.id, { status: "working" });
    mkdirSync(dirname(taskRuntimeLeasePath(task.id)), { recursive: true });
    writeFileSync(taskRuntimeLeasePath(task.id), JSON.stringify({ token: "other-worker", pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now() }), "utf8");

    const before = fakePi.sessions.at(-1)?.prompts.length ?? 0;
    await expect(getTaskDetail(task.id)).resolves.toMatchObject({ id: task.id, isStreaming: true });
    const result = await promptTask(task.id, "ユーザーからの追加指示", undefined, { streamingBehavior: "followUp" });

    expect(result.id).toBe(task.id);
    expect(fakePi.sessions.at(-1)?.prompts.length ?? 0).toBe(before);
    const requestDir = join(dir, "bot-code-requests");
    const requestFile = readdirSync(requestDir).find((name) => name.endsWith(".json"));
    expect(requestFile).toBeDefined();
    expect(JSON.parse(readFileSync(join(requestDir, requestFile!), "utf8"))).toMatchObject({
      botId: bot.id,
      codeTaskId: task.id,
      userIntervention: true,
      state: "queued",
      prompt: "ユーザーからの追加指示",
      promptOptions: { streamingBehavior: "followUp" },
    });
  });

  it("keeps Pi native compaction enabled for a Goal Loop session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-goal-loop-compaction-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    __resetPiAgentDirCacheForTests();
    installHarness(new Map());

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "Goal loop context compaction",
      goalLoop: { maxTurns: 1 },
    });

    assert.equal(fakePi.sessions[0]?.compactionEnabledHistory[0], true);
    assert.ok(task.sessionFile);
    const header = JSON.parse(readFileSync(task.sessionFile, "utf8").split("\n", 1)[0]);
    assert.equal(header.id, task.sessionId);
  });

  it("reselects the Auto agent before every Goal Loop turn and keeps the transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auto-agent-goal-loop-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    for (const name of ["builder", "reviewer"]) {
      writeFileSync(
        join(agentDir, "agents", `${name}.md`),
        `---\nname: ${name}\n---\n`,
        "utf8",
      );
    }
    installHarness(new Map());
    autoAgentMock
      .mockResolvedValueOnce("reviewer")
      .mockResolvedValueOnce("builder");

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "最初の確認",
      agent: "builder",
      goalLoop: { maxTurns: 2, autoAgent: true },
    });
    const sessionId = task.sessionId;
    assert.ok(sessionId);
    const loopFile = goalLoopStateFile(dir, sessionId);
    mkdirSync(dirname(loopFile), { recursive: true });
    writeFileSync(
      loopFile,
      JSON.stringify({
        id: sessionId,
        sessionId,
        cwd: dir,
        status: "queued",
        goal: "Goal loop",
        acceptance: [],
        maxTurns: 2,
        cooldownSeconds: 0,
        nextTurnAt: null,
        forceFullRun: false,
        autoAgent: true,
        turnCount: 0,
        turnKind: "goal",
        pauseReason: "",
        error: "",
        progress: [],
        summary: "",
        evidence: "",
        blockedReason: "",
        rejectedClaims: 0,
        unreadableStreak: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    type PrepareTurn = (prompt: string) => Promise<boolean | "retry">;
    const firstPrepare = fakePi.sessions[0]?.routingContext
      ?.prepareGoalLoopTurn as PrepareTurn;
    assert.equal(await firstPrepare("turn 1"), false);
    assert.equal(fakePi.sessions.length, 2);
    assert.equal(getTask(task.id)?.agent, "reviewer");
    expect(fakePi.sessions[0]).toMatchObject({
      file: fakePi.sessions[1]?.file,
      disposed: true,
      customMessages: [{ customType: "leafcode-pi.agent-switch" }],
    });
    assert.equal(fakePi.sessions[1]?.initialMessageCount, 2);

    const secondPrepare = fakePi.sessions[1]?.routingContext
      ?.prepareGoalLoopTurn as PrepareTurn;
    assert.equal(await secondPrepare("turn 2"), false);
    assert.equal(fakePi.sessions.length, 3);
    assert.equal(getTask(task.id)?.agent, "builder");
    expect(fakePi.sessions[1]).toMatchObject({
      file: fakePi.sessions[2]?.file,
      disposed: true,
      customMessages: [{ customType: "leafcode-pi.agent-switch" }],
    });
    assert.equal(fakePi.sessions[2]?.initialMessageCount, 3);
    expect(autoAgentMock).toHaveBeenCalledTimes(2);
    assert.equal(JSON.parse(readFileSync(loopFile, "utf8")).autoAgent, true);
  });

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
      join(agentDir, "agents", "builder.md"),
      "---\nname: builder\nmodel: anthropic/claude-sonnet\n---\n",
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
      agent: "builder",
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
      join(agentDir, "agents", "builder.md"),
      "---\nname: builder\nmodel: anthropic/claude-sonnet\nthinking: max\n---\n",
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
      agent: "builder",
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

  it("reopens a dynamic task when its saved account and model are stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-stale-resume-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    const removed = createAccount({ label: "削除済み", providers: ["anthropic"] });
    const fallback = createAccount({ label: "再開先", providers: ["anthropic"] });
    storeProviderAuth(removed.id, agentDir);
    storeProviderAuth(fallback.id, agentDir);
    installHarness(
      new Map([
        [removed.id, runtime(removed.id)],
        [fallback.id, runtime(fallback.id)],
      ]),
    );
    await setAccountRoutingMode("anthropic", "integrated");
    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: "anthropic", accountId: removed.id, usedPercent: 0 },
          { codexBarProviderId: "anthropic", accountId: fallback.id, usedPercent: 100 },
        ],
      }),
    );

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "再開対象",
      model: "anthropic::claude-sonnet",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");
    assert.equal(getTask(task.id)?.accountId, removed.id);

    deleteAccount(removed.id);
    dropLiveSessions();
    await getTaskDetail(task.id);
    assert.equal(getTask(task.id)?.accountId, fallback.id);
    expect(fakePi.sessions[1]).toMatchObject({ accountId: fallback.id });

    patchTask(task.id, { modelID: "removed-model" });
    dropLiveSessions();
    await getTaskDetail(task.id);
    expect(fakePi.sessions[2]).toMatchObject({ accountId: fallback.id });
    patchTask(task.id, { modelID: "claude-sonnet" });

    await promptTask(
      task.id,
      "中断したターンを再開",
      undefined,
      {
        model: `${removed.id}::anthropic::claude-sonnet`,
        resume: true,
      },
    );
    await waitFor(() => getTask(task.id)?.status === "idle");
    expect(fakePi.sessions[2]?.prompts).toEqual(["中断したターンを再開"]);
    assert.equal(getTask(task.id)?.accountId, fallback.id);
  });

  it("still ranks by usage when the 5 minute usage cache has expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-stale-usage-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();

    // 使用量不明で選ばれると登録順の先頭（=使用量大）が選ばれるため、順序を逆にする。
    const high = createAccount({ label: "使用量大", providers: ["anthropic"] });
    const low = createAccount({ label: "使用量小", providers: ["anthropic"] });
    storeProviderAuth(high.id, agentDir);
    storeProviderAuth(low.id, agentDir);
    installHarness(new Map([[high.id, runtime(high.id)], [low.id, runtime(low.id)]]));
    await setAccountRoutingMode("anthropic", "integrated");
    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: "anthropic", accountId: high.id, usedPercent: 98 },
          { codexBarProviderId: "anthropic", accountId: low.id, usedPercent: 30 },
        ],
      }),
      Date.now() - 10 * 60 * 1000,
    );

    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = await createTask({
      projectId: project.id,
      prompt: "キャッシュ期限切れでも余裕のあるアカウントへ",
      model: "anthropic::claude-sonnet",
    });
    await waitFor(() => getTask(task.id)?.status === "idle");

    assert.equal(getTask(task.id)?.accountId, low.id);
    expect(fakePi.sessions[0]).toMatchObject({ accountId: low.id });
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

    // 明示アカウントでもリミット時だけは別アカウントへ自動フォールバックする。
    fakePi.sessions[0]?.emit?.({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", errorMessage: "HTTP 429 Too Many Requests" }],
    });
    fakePi.sessions[0]?.emit?.({ type: "agent_settled" });
    await waitFor(() => fakePi.sessions.length === 2);
    expect(fakePi.sessions[1]).toMatchObject({ accountId: other.id });
    assert.equal(getTask(task.id)?.accountId, other.id);
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

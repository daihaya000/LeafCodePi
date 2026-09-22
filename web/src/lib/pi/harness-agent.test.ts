import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { getProject, getTask, insertBotTask, insertTask, patchProject, patchTask, upsertProject } from "@/lib/store";
import {
  armTaskHangWatch,
  getTaskHangWatch,
  stopHangWatchdogForTests,
} from "./hang-watchdog";
import { abortLiveForHangWatchdog, abortTask, archiveTask, destroyProject, destroyTask, getTaskDetail, isLiveBusyForReplace, isTaskRuntimeOwnedElsewhere, markTaskWorkingIfIdle, refreshLiveSessionsForAgentDefinition, reloadLiveSessionsContext, restoreTask, setBotPermissionMode, setBotTools, setTaskAgent, throwIfBusyForModelChange, throwIfBusyForPermissionChange, throwIfBusyForSkillPermissionChange, throwIfBusyForThinkingChange } from "./harness";
import { taskRuntimeLeasePath } from "@/lib/task-runtime-lease";
import { botTaskId, createBot, getBot, patchBot } from "@/lib/bots";
import { setAgentEnabled } from "@/lib/agents";
import { roomBotTaskId } from "@/lib/rooms";

const GLOBAL_KEY = "__leafcodePiHarness";
const previousHarness = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  stopHangWatchdogForTests();
  if (previousHarness === undefined) delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  else (globalThis as Record<string, unknown>)[GLOBAL_KEY] = previousHarness;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FixtureCustomMessage = { customType: string; content: unknown; display: boolean };

/**
 * Write the `reviewer` persona into `agentDir` and opt it in. listAgents leaves
 * every non-default agent disabled, and setTaskAgent rejects disabled personas,
 * so writing the .md alone is not enough to make it selectable.
 */
function writeEnabledReviewerAgent(agentDir: string): void {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", "reviewer.md"),
    "---\nname: reviewer\n---\n\nReview the work.\n",
    "utf8",
  );
  setAgentEnabled("reviewer", true, agentDir);
}

/**
 * live エントリの最低要件。本体の LiveRuntime と同じく `taskId` を必須にしておく。
 * harness 側は live.taskId を起点に getTask / getTaskHangWatch を引くため、
 * これが欠けると undefined を渡して TypeError になる（型で検出できないと再発する）。
 */
type FixtureLive = { taskId: string } & Record<string, unknown>;

/**
 * GLOBAL_KEY へ harness state を入れる唯一の経路。live の taskId 必須を型で強制するので、
 * ここを通さない生代入を追加しないこと（型検査をすり抜けて undefined が混ざる）。
 */
function installFixtureHarness(
  live: Map<string, FixtureLive>,
  options: { events?: EventEmitter; pi?: unknown } = {},
): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    live,
    events: options.events ?? new EventEmitter(),
    ...(options.pi === undefined ? {} : { pi: options.pi }),
  };
}

function fixture(options: {
  messages?: unknown[];
  promptActive?: boolean;
  isCompacting?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-agent-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
  writeEnabledReviewerAgent(agentDir);

  const project = upsertProject({ name: "demo", rootPath: root });
  const task = insertTask({ project, title: "switch agent", agent: "builder" });
  let unsubscribed = false;
  let disposed = false;
  const customMessages: FixtureCustomMessage[] = [];
  const live = new Map([[task.id, {
    taskId: task.id,
    accountId: null,
    promptActive: options.promptActive ?? false,
    session: {
      isStreaming: false,
      isCompacting: options.isCompacting ?? false,
      messages: options.messages ?? [],
      sendCustomMessage: async (message: FixtureCustomMessage) => {
        customMessages.push(message);
      },
      reload: async () => undefined,
      dispose: () => {
        disposed = true;
      },
    },
    unsubscribe: () => {
      unsubscribed = true;
    },
  }]]);
  installFixtureHarness(live);
  return {
    task,
    live,
    customMessages,
    get disposed() { return disposed; },
    get unsubscribed() { return unsubscribed; },
  };
}

describe("refreshLiveSessionsForAgentDefinition", () => {
  it("recreates an idle selected-agent session on its next prompt", () => {
    const state = fixture();

    assert.deepEqual(refreshLiveSessionsForAgentDefinition("builder"), { refreshed: 1, deferred: 0 });
    assert.equal(state.live.has(state.task.id), false);
    assert.equal(state.disposed, true);
  });

  it("defers an active selected-agent session", () => {
    const state = fixture({ promptActive: true });

    assert.deepEqual(refreshLiveSessionsForAgentDefinition("builder"), { refreshed: 0, deferred: 1 });
    assert.equal(state.live.has(state.task.id), true);
    assert.equal(
      (state.live.get(state.task.id) as { agentDefinitionReloadPending?: boolean } | undefined)?.agentDefinitionReloadPending,
      true,
    );
  });
});

describe("setTaskAgent", () => {
  it("persists the selected persona and disposes the idle session for restart", async () => {
    const state = fixture();
    armTaskHangWatch({ taskId: state.task.id, prompt: "作業" });

    const updated = await setTaskAgent(state.task.id, "reviewer");

    assert.equal(updated.agent, "reviewer");
    assert.equal(getTask(state.task.id)?.agent, "reviewer");
    assert.equal(state.live.has(state.task.id), false);
    assert.equal(state.disposed, true);
    assert.equal(state.unsubscribed, true);
    assert.equal(getTaskHangWatch(state.task.id), null);
    // An empty transcript has no stale persona history to disambiguate.
    assert.equal(state.customMessages.length, 0);
  });

  it("announces the persona switch on a non-empty transcript so the new persona does not inherit the old identity", async () => {
    const state = fixture({ messages: [{ role: "user", content: "作業" }] });

    await setTaskAgent(state.task.id, "reviewer");

    assert.equal(state.customMessages.length, 1);
    const notice = state.customMessages[0]!;
    assert.equal(notice.customType, "leafcode-pi.agent-switch");
    assert.equal(notice.display, false);
    assert.equal(typeof notice.content, "string");
    assert.match(notice.content as string, /"builder"/);
    assert.match(notice.content as string, /"reviewer"/);
    assert.match(notice.content as string, /after the most recent agent-switch notice/);
    assert.doesNotMatch(notice.content as string, /Everything above this line/);
  });

  it.each([
    ["an accepted prompt", { promptActive: true }],
    ["compaction", { isCompacting: true }],
  ])("defers a persona switch during %s", async (_label, options) => {
    const state = fixture({
      ...options,
      messages: [{ role: "user", content: "作業" }],
    });

    await setTaskAgent(state.task.id, "reviewer");

    assert.equal(getTask(state.task.id)?.agent, "reviewer");
    assert.equal(state.live.has(state.task.id), true);
    assert.equal(state.disposed, false);
    assert.equal(state.customMessages.length, 0);
  });

  it("defers a persona switch while a Goal loop is queued", async () => {
    const state = fixture();
    const sessionId = "goal-switch-session";
    const live = state.live.get(state.task.id) as { session: { sessionId?: string } } | undefined;
    if (live) live.session.sessionId = sessionId;
    const goalDir = join(state.task.directory, "data", "goals-loop");
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(
      join(goalDir, `${sessionId}.json`),
      JSON.stringify({ goal: "作業", status: "queued" }),
      "utf8",
    );

    await setTaskAgent(state.task.id, "reviewer");

    assert.equal(getTask(state.task.id)?.agent, "reviewer");
    assert.equal(state.disposed, false);
  });
});

describe("isLiveBusyForReplace", () => {
  it("blocks dispose while a prompt is accepted, streaming, or compacting", () => {
    assert.equal(
      isLiveBusyForReplace({ promptActive: true, session: {} }),
      true,
    );
    assert.equal(
      isLiveBusyForReplace({ promptActive: false, session: { isStreaming: true } }),
      true,
    );
    assert.equal(
      isLiveBusyForReplace({ promptActive: false, session: { isCompacting: true } }),
      true,
    );
    assert.equal(
      isLiveBusyForReplace({ promptActive: false, session: {} }),
      false,
    );
  });

  it("blocks same-account model changes during an accepted prompt", () => {
    assert.throws(
      () => throwIfBusyForModelChange({ promptActive: true, session: {} }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        /モデルは変更できません/.test(error.message),
    );
    throwIfBusyForModelChange({ promptActive: false, session: {} });
  });

  it("blocks thinking-level changes during an accepted prompt", () => {
    assert.throws(
      () => throwIfBusyForThinkingChange({ promptActive: true, session: {} }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        /思考レベルは変更できません/.test(error.message),
    );
    throwIfBusyForThinkingChange({ promptActive: false, session: {} });
  });

  it("blocks permission and skill-permission changes during an accepted prompt", () => {
    assert.throws(
      () => throwIfBusyForPermissionChange({ promptActive: true, session: {} }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        /権限モードは変更できません/.test(error.message),
    );
    assert.throws(
      () => throwIfBusyForSkillPermissionChange({ promptActive: true, session: {} }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        /スキル権限は変更できません/.test(error.message),
    );
    throwIfBusyForPermissionChange({ promptActive: false, session: {} });
    throwIfBusyForSkillPermissionChange({ promptActive: false, session: {} });
  });
});

describe("markTaskWorkingIfIdle", () => {
  it("promotes an idle task so the stop control can appear before agent_start", () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-working-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "queued prompt" });
    assert.equal(getTask(task.id)?.status, "idle");
    assert.equal(markTaskWorkingIfIdle(task.id), true);
    assert.equal(getTask(task.id)?.status, "working");
    assert.equal(markTaskWorkingIfIdle(task.id), false);
  });
});

describe("abortTask", () => {
  it("disarms hang retry after an explicit user stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-abort-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "abort task" });
    let abortCount = 0;
    let abortRequested = false;
    let clearQueueCount = 0;
    const session = {
      get messages() {
        assert.equal(abortRequested, true, "SDK abort must precede history projection");
        return [{ role: "user", content: "作業", timestamp: 1 }];
      },
      agent: { state: { streamingMessage: undefined } },
      isStreaming: true,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: { getCommand: () => undefined },
      clearQueue: () => {
        clearQueueCount += 1;
        return { steering: ["steer"], followUp: ["follow"] };
      },
      abort: async () => {
        abortRequested = true;
        abortCount += 1;
      },
    };
    const live: Map<string, FixtureLive> = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: true,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    installFixtureHarness(live);

    armTaskHangWatch({ taskId: task.id, prompt: "作業" });
    assert.ok(getTaskHangWatch(task.id));

    await abortTask(task.id);

    assert.equal(abortCount, 1);
    assert.equal(clearQueueCount, 1);
    assert.equal(getTaskHangWatch(task.id), null);
    assert.equal(getTask(task.id)?.status, "idle");
    assert.equal(getTask(task.id)?.manualAbortedAssistantId, "");
    const abortedLive = live.get(task.id);
    assert.equal(abortedLive?.promptEpoch, 1);
    assert.equal(abortedLive?.promptActive, false);
  });

  it("clears steer/follow-up queues when the hang watchdog aborts", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-hang-abort-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "hang abort task" });
    let abortCount = 0;
    let clearQueueCount = 0;
    const eventTypes: string[] = [];
    let queueCleared = false;
    let sessionAbortAfterQueueClear = false;
    const session = {
      sessionId: "hang-abort-session",
      messages: [{ role: "user", content: "作業", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } },
      isStreaming: true,
      isCompacting: false,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: { getCommand: () => undefined },
      clearQueue: () => {
        clearQueueCount += 1;
        queueCleared = true;
        return { steering: ["steer"], followUp: ["follow"] };
      },
      abort: async () => {
        sessionAbortAfterQueueClear = queueCleared;
        abortCount += 1;
      },
    };
    const live = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: true,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    const events = new EventEmitter();
    let hangAbortManualId: string | null | undefined;
    let hangAbortStreaming: boolean | undefined;
    let hangIdleStatus: string | undefined;
    events.on(task.id, (payload: {
      eventType?: string;
      manualAbortedAssistantId?: string | null;
      isStreaming?: boolean;
      task?: { status?: string };
    }) => {
      if (payload.eventType) eventTypes.push(payload.eventType);
      if (payload.eventType === "hang_abort") {
        hangAbortManualId = payload.manualAbortedAssistantId;
        hangAbortStreaming = payload.isStreaming;
      }
      if (payload.eventType === "hang_idle") {
        hangIdleStatus = payload.task?.status;
      }
    });
    installFixtureHarness(live, { events });

    armTaskHangWatch({ taskId: task.id, prompt: "作業" });
    await abortLiveForHangWatchdog(task.id);

    assert.equal(abortCount, 1);
    assert.equal(clearQueueCount, 1);
    assert.equal(getTask(task.id)?.status, "idle");
    assert.ok(getTaskHangWatch(task.id));
    assert.equal(eventTypes[0], "hang_abort");
    assert.ok(eventTypes.includes("hang_idle"));
    assert.equal(sessionAbortAfterQueueClear, true);
    assert.equal(hangAbortStreaming, false);
    assert.equal(hangIdleStatus, "idle");
    assert.equal(getTask(task.id)?.manualAbortedAssistantId, "");
    assert.equal(hangAbortManualId, "");
  });

  it("signals abort before stopping a queued Goal Loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-goal-abort-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "abort goal loop" });
    const sessionId = "goal-abort-session";
    const goalDir = join(root, "data", "goals-loop");
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(
      join(goalDir, `${sessionId}.json`),
      JSON.stringify({ goal: "作業", status: "queued" }),
      "utf8",
    );
    const events: string[] = [];
    const session = {
      sessionId,
      messages: [{ role: "user", content: "作業", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } },
      isStreaming: false,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: {
        getCommand: (name: string) =>
          name === "goal-stop"
            ? { handler: async () => events.push("goal-stop") }
            : undefined,
        createCommandContext: () => ({}),
      },
      abort: async () => {
        events.push("abort");
      },
    };
    const live: Map<string, FixtureLive> = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: false,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    installFixtureHarness(live);

    await abortTask(task.id);

    assert.deepEqual(events, ["abort", "goal-stop"]);
    assert.equal(getTask(task.id)?.status, "idle");
  });
});

describe("archiveTask", () => {
  it("archives an idle task without creating a live session", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-archive-idle-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "archive idle" });
    const live = new Map();
    const events = new EventEmitter();
    const emitted: string[] = [];
    events.on(task.id, (payload: { eventType?: string; task?: { status?: string } }) => {
      if (payload.eventType) emitted.push(payload.eventType);
    });
    installFixtureHarness(live, { events });

    const archived = await archiveTask(task.id);
    const detail = await getTaskDetail(task.id);

    assert.equal(archived.status, "archived");
    assert.equal(getTask(task.id)?.status, "archived");
    assert.equal(detail.status, "archived");
    assert.equal(detail.isStreaming, false);
    assert.equal(live.has(task.id), false);
    assert.equal(emitted.at(-1), "archived");
  });

  it("emits restored so an open archived view can unlock the composer", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-restore-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "restore archived" });
    const live = new Map();
    const events = new EventEmitter();
    const emitted: Array<{ eventType?: string; status?: string }> = [];
    events.on(task.id, (payload: { eventType?: string; task?: { status?: string } }) => {
      emitted.push({ eventType: payload.eventType, status: payload.task?.status });
    });
    installFixtureHarness(live, { events });

    await archiveTask(task.id);
    const restored = restoreTask(task.id);

    assert.equal(restored.status, "idle");
    assert.equal(getTask(task.id)?.status, "idle");
    assert.equal(emitted.at(-1)?.eventType, "restored");
    assert.equal(emitted.at(-1)?.status, "idle");
  });

  it("rejects restore when the parent project is still archived", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-restore-archived-project-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "restore under archived project" });
    installFixtureHarness(new Map());

    await archiveTask(task.id);
    patchProject(project.id, { archived: true });

    assert.throws(
      () => restoreTask(task.id),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        error.message.includes("アーカイブ済みのプロジェクト"),
    );
    assert.equal(getTask(task.id)?.status, "archived");
  });

  it("returns archived transcript without recreating a live session", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-archive-history-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "archive history" });
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    patchTask(task.id, { sessionFile, status: "archived" });
    const live = new Map();
    let opened = 0;
    installFixtureHarness(live, {
      pi: {
        SessionManager: {
          open: (file: string) => {
            opened += 1;
            assert.equal(file, sessionFile);
            return {
              buildSessionContext: () => ({
                messages: [
                  { role: "user", content: "保存された会話", timestamp: 1 },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "応答" }],
                    timestamp: 2,
                  },
                ],
              }),
            };
          },
        },
      },
    });

    const detail = await getTaskDetail(task.id);

    assert.equal(opened, 1);
    assert.equal(detail.status, "archived");
    assert.equal(detail.isStreaming, false);
    assert.equal(live.has(task.id), false);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[0]?.role, "user");
    const userText = detail.messages[0]?.parts.find((part) => part.type === "text");
    assert.equal(userText && "text" in userText ? userText.text : undefined, "保存された会話");
    assert.equal(detail.messages[1]?.role, "assistant");
  });

  it("aborts a running session before marking the task archived", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-archive-busy-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "archive running" });
    let abortCount = 0;
    let clearQueueCount = 0;
    let disposed = false;
    const session = {
      messages: [{ role: "user", content: "作業", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } },
      isStreaming: true,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: { getCommand: () => undefined },
      clearQueue: () => {
        clearQueueCount += 1;
        return { steering: ["steer"], followUp: ["follow"] };
      },
      abort: async () => {
        abortCount += 1;
      },
      dispose: () => {
        disposed = true;
      },
    };
    const live: Map<string, FixtureLive> = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: true,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    installFixtureHarness(live);

    armTaskHangWatch({ taskId: task.id, prompt: "作業" });
    const archived = await archiveTask(task.id);
    const detail = await getTaskDetail(task.id);

    assert.equal(abortCount, 1);
    assert.equal(clearQueueCount, 1);
    assert.equal(disposed, true);
    assert.equal(archived.status, "archived");
    assert.equal(getTask(task.id)?.status, "archived");
    assert.equal(getTaskHangWatch(task.id), null);
    assert.equal(live.has(task.id), false);
    assert.equal(detail.status, "archived");
  });

  it("stops a Goal loop and refuses later session recreation", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-archive-goal-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeEnabledReviewerAgent(agentDir);
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "archive goal loop", agent: "builder" });
    const sessionId = "archive-goal-session";
    const goalDir = join(root, "data", "goals-loop");
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(
      join(goalDir, `${sessionId}.json`),
      JSON.stringify({ goal: "作業", status: "queued" }),
      "utf8",
    );
    const events: string[] = [];
    const session = {
      sessionId,
      messages: [{ role: "user", content: "作業", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } },
      isStreaming: false,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: {
        getCommand: (name: string) =>
          name === "goal-stop"
            ? { handler: async () => events.push("goal-stop") }
            : undefined,
        createCommandContext: () => ({}),
      },
      abort: async () => {
        events.push("abort");
      },
      dispose: () => {
        events.push("dispose");
      },
    };
    const live: Map<string, FixtureLive> = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: false,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    installFixtureHarness(live);

    await archiveTask(task.id);

    assert.deepEqual(events, ["abort", "goal-stop", "dispose"]);
    assert.equal(getTask(task.id)?.status, "archived");
    assert.equal(live.has(task.id), false);

    await assert.rejects(
      setTaskAgent(task.id, "reviewer"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        error.message.includes("アーカイブ"),
    );
    assert.equal(getTask(task.id)?.agent, "builder");
  });
});

describe("destroyTask", () => {
  it("aborts a running session before deleting the task", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-destroy-busy-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "destroy running" });
    let abortCount = 0;
    let clearQueueCount = 0;
    let disposed = false;
    const session = {
      messages: [{ role: "user", content: "作業", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } },
      isStreaming: true,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: { getCommand: () => undefined },
      clearQueue: () => {
        clearQueueCount += 1;
        return { steering: ["steer"], followUp: ["follow"] };
      },
      abort: async () => {
        abortCount += 1;
      },
      dispose: () => {
        disposed = true;
      },
    };
    const live: Map<string, FixtureLive> = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: true,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    installFixtureHarness(live);

    armTaskHangWatch({ taskId: task.id, prompt: "作業" });
    await destroyTask(task.id);

    assert.equal(abortCount, 1);
    assert.equal(clearQueueCount, 1);
    assert.equal(disposed, true);
    assert.equal(getTask(task.id), undefined);
    assert.equal(getTaskHangWatch(task.id), null);
    assert.equal(live.has(task.id), false);
  });

  it("stops a Goal loop before deleting a project", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-destroy-project-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "destroy project live" });
    const sessionId = "destroy-project-session";
    const goalDir = join(root, "data", "goals-loop");
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(
      join(goalDir, `${sessionId}.json`),
      JSON.stringify({ goal: "作業", status: "queued" }),
      "utf8",
    );
    const events: string[] = [];
    const session = {
      sessionId,
      messages: [{ role: "user", content: "作業", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } },
      isStreaming: false,
      sessionManager: {
        getLeafId: () => null,
        getBranch: () => [],
        getCwd: () => root,
      },
      extensionRunner: {
        getCommand: (name: string) =>
          name === "goal-stop"
            ? { handler: async () => events.push("goal-stop") }
            : undefined,
        createCommandContext: () => ({}),
      },
      abort: async () => {
        events.push("abort");
      },
      dispose: () => {
        events.push("dispose");
      },
    };
    const live: Map<string, FixtureLive> = new Map([[task.id, {
      taskId: task.id,
      accountId: null,
      session,
      skillPermission: "allow",
      skillPermissionRef: { current: "allow" },
      unsubscribe: () => {},
      promptChain: Promise.resolve(),
      promptActive: false,
      promptEpoch: 0,
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      snapshotTimer: null,
      pendingSnapshotEventType: null,
      revertLeafId: null,
      manualAbortedAssistantId: null,
      hangRetryCount: 0,
      reasoningFallbackTried: false,
    }]]);
    installFixtureHarness(live);

    await destroyProject(project.id);

    assert.deepEqual(events, ["abort", "goal-stop", "dispose"]);
    assert.equal(getTask(task.id), undefined);
    assert.equal(getProject(project.id), undefined);
    assert.equal(live.has(task.id), false);
  });

  it("clears Bot codeSessionTaskId links when destroying a Code task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-destroy-code-link-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const bot = createBot({ name: "Linked" });
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = insertTask({ project, title: "code" });
    patchBot(bot.id, { codeSessionTaskId: task.id });
    assert.equal(getBot(bot.id)?.codeSessionTaskId, task.id);

    await destroyTask(task.id);

    assert.equal(getTask(task.id), undefined);
    assert.equal(getBot(bot.id)?.codeSessionTaskId, null);
  });
});

describe("archiveTask codeSession links", () => {
  it("clears Bot codeSessionTaskId when archiving the linked Code task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-archive-code-link-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const bot = createBot({ name: "Archive link" });
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = insertTask({ project, title: "code" });
    patchBot(bot.id, { codeSessionTaskId: task.id });
    installFixtureHarness(new Map());

    await archiveTask(task.id);

    assert.equal(getTask(task.id)?.status, "archived");
    assert.equal(getBot(bot.id)?.codeSessionTaskId, null);
  });
});

describe("setBotTools", () => {
  it("defers tool changes while a Bot session is busy", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-tools-defer-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const bot = createBot({ name: "Tools defer" });
    const taskId = botTaskId(bot.id);
    let applied: string[] | null = null;
    const liveEntry = {
      taskId,
      promptActive: true,
      pendingSettings: undefined as { botTools?: readonly string[] } | undefined,
      session: {
        isStreaming: false,
        isCompacting: false,
        getActiveToolNames: () => ["read", "grep", "bash"],
        setActiveToolsByName: (names: string[]) => {
          applied = names;
        },
      },
      unsubscribe: () => undefined,
    };
    installFixtureHarness(new Map([[taskId, liveEntry]]));

    setBotTools(bot.id, ["read"]);

    assert.equal(applied, null);
    assert.deepEqual(liveEntry.pendingSettings?.botTools, ["read"]);
  });

  it("applies tools immediately when the Bot session is idle", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-tools-idle-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const bot = createBot({ name: "Tools idle" });
    const taskId = botTaskId(bot.id);
    let applied: string[] | null = null;
    installFixtureHarness(new Map([[taskId, {
      taskId,
      promptActive: false,
      session: {
        isStreaming: false,
        isCompacting: false,
        getActiveToolNames: () => ["read", "grep", "bash"],
        setActiveToolsByName: (names: string[]) => {
          applied = names;
        },
      },
      unsubscribe: () => undefined,
    }]]));

    setBotTools(bot.id, ["read"]);

    assert.deepEqual(applied, ["read"]);
  });
});

describe("setBotPermissionMode cold Room tasks", () => {
  it("patches idle Room Bot task records without creating a live session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-bot-perm-cold-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const bot = createBot({ name: "Perm cold", permissionMode: "allow" });
    const roomTaskId = roomBotTaskId("room-cold", bot.id);
    insertBotTask({
      id: roomTaskId,
      botId: bot.id,
      name: bot.name,
      directory: join(dir, "room-ws"),
      permissionMode: "allow",
    });
    const primaryId = botTaskId(bot.id);
    installFixtureHarness(new Map([[primaryId, {
      taskId: primaryId,
      promptActive: false,
      session: {
        isStreaming: false,
        isCompacting: false,
        setPermissionMode: () => undefined,
      },
      unsubscribe: () => undefined,
    }]]));

    await setBotPermissionMode(bot.id, "ask");

    assert.equal(getTask(roomTaskId)?.permissionMode, "ask");
    assert.equal(
      ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as { live: Map<string, unknown> }).live.has(roomTaskId),
      false,
    );
  });
});

describe("isTaskRuntimeOwnedElsewhere", () => {
  it("detects a foreign lease on ordinary Code tasks without a botId", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-owned-elsewhere-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    mkdirSync(join(dir, "task-leases"), { recursive: true });
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = insertTask({ project, title: "plain code" });
    writeFileSync(
      taskRuntimeLeasePath(task.id),
      `${JSON.stringify({
        token: "other-worker",
        pid: process.pid,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      })}\n`,
    );
    assert.equal(isTaskRuntimeOwnedElsewhere(getTask(task.id)!), true);
    assert.equal(task.botId, undefined);
  });
});

describe("reloadLiveSessionsContext", () => {
  it("reloads idle sessions and defers busy ones without calling reload", async () => {
    const { task, live } = fixture({ promptActive: true });
    let busyReloads = 0;
    let idleReloads = 0;
    const busy = live.get(task.id)! as {
      soulReloadPending?: boolean;
      contextReloadPending?: boolean;
      session: { reload?: () => Promise<void>; isStreaming: boolean; isCompacting: boolean };
      promptActive: boolean;
    };
    busy.session.reload = async () => {
      busyReloads += 1;
    };

    const idleId = `${task.id}-idle`;
    live.set(idleId, {
      taskId: idleId,
      accountId: null,
      promptActive: false,
      session: {
        isStreaming: false,
        isCompacting: false,
        messages: [],
        sendCustomMessage: async () => undefined,
        reload: async () => {
          idleReloads += 1;
        },
        dispose: () => undefined,
      },
      unsubscribe: () => undefined,
    });
    Object.assign(live.get(idleId)!, {
      soulReloadPending: false,
      contextReloadPending: false,
    });

    const result = await reloadLiveSessionsContext();
    assert.equal(busyReloads, 0);
    assert.equal(idleReloads, 1);
    assert.equal(result.reloaded, 1);
    assert.equal(result.deferred, 1);
    assert.equal(busy.contextReloadPending, true);
  });
});

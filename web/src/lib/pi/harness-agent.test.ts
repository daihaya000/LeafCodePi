import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { getProject, getTask, insertTask, patchTask, upsertProject } from "@/lib/store";
import {
  armTaskHangWatch,
  getTaskHangWatch,
  stopHangWatchdogForTests,
} from "./hang-watchdog";
import { abortLiveForHangWatchdog, abortTask, archiveTask, destroyProject, destroyTask, getTaskDetail, isLiveBusyForReplace, markTaskWorkingIfIdle, restoreTask, setTaskAgent, throwIfBusyForModelChange, throwIfBusyForPermissionChange, throwIfBusyForSkillPermissionChange, throwIfBusyForThinkingChange } from "./harness";

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

function fixture(options: {
  messages?: unknown[];
  promptActive?: boolean;
  isCompacting?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-agent-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", "reviewer.md"),
    "---\nname: reviewer\n---\n\nReview the work.\n",
    "utf8",
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");

  const project = upsertProject({ name: "demo", rootPath: root });
  const task = insertTask({ project, title: "switch agent", agent: "build" });
  let unsubscribed = false;
  let disposed = false;
  const customMessages: FixtureCustomMessage[] = [];
  const live = new Map([[task.id, {
    accountId: null,
    promptActive: options.promptActive ?? false,
    session: {
      isStreaming: false,
      isCompacting: options.isCompacting ?? false,
      messages: options.messages ?? [],
      sendCustomMessage: async (message: FixtureCustomMessage) => {
        customMessages.push(message);
      },
      dispose: () => {
        disposed = true;
      },
    },
    unsubscribe: () => {
      unsubscribed = true;
    },
  }]]);
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    live,
    events: new EventEmitter(),
  };
  return {
    task,
    live,
    customMessages,
    get disposed() { return disposed; },
    get unsubscribed() { return unsubscribed; },
  };
}

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
    assert.match(notice.content as string, /"build"/);
    assert.match(notice.content as string, /"reviewer"/);
    assert.match(notice.content as string, /after the most recent agent-switch notice/);
    assert.doesNotMatch(notice.content as string, /Everything above this line/);
  });

  it.each([
    ["an accepted prompt", { promptActive: true }],
    ["compaction", { isCompacting: true }],
  ])("rejects a persona switch during %s", async (_label, options) => {
    const state = fixture({
      ...options,
      messages: [{ role: "user", content: "作業" }],
    });

    await assert.rejects(
      setTaskAgent(state.task.id, "reviewer"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409,
    );

    assert.equal(getTask(state.task.id)?.agent, "build");
    assert.equal(state.live.has(state.task.id), true);
    assert.equal(state.disposed, false);
    assert.equal(state.customMessages.length, 0);
  });

  it("rejects a persona switch while a Goal loop is queued", async () => {
    const state = fixture();
    const sessionId = "goal-switch-session";
    const live = state.live.get(state.task.id) as { session: { sessionId?: string } } | undefined;
    if (live) live.session.sessionId = sessionId;
    const goalDir = join(state.task.directory, ".pi", "goals-loop");
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(
      join(goalDir, `${sessionId}.json`),
      JSON.stringify({ goal: "作業", status: "queued" }),
      "utf8",
    );

    await assert.rejects(
      setTaskAgent(state.task.id, "reviewer"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        /Goal loop/.test(error.message),
    );

    assert.equal(getTask(state.task.id)?.agent, "build");
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
    let clearQueueCount = 0;
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
    };
    const live = new Map([[task.id, {
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
    };

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
    let hangAbortBeforeSessionAbort = false;
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
        return { steering: ["steer"], followUp: ["follow"] };
      },
      abort: async () => {
        hangAbortBeforeSessionAbort = eventTypes.includes("hang_abort");
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
    events.on(task.id, (payload: { eventType?: string; manualAbortedAssistantId?: string | null }) => {
      if (payload.eventType) eventTypes.push(payload.eventType);
      if (payload.eventType === "hang_abort") {
        hangAbortManualId = payload.manualAbortedAssistantId;
      }
    });
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events,
    };

    armTaskHangWatch({ taskId: task.id, prompt: "作業" });
    await abortLiveForHangWatchdog(task.id);

    assert.equal(abortCount, 1);
    assert.equal(clearQueueCount, 1);
    assert.equal(getTask(task.id)?.status, "idle");
    assert.ok(getTaskHangWatch(task.id));
    assert.equal(eventTypes[0], "hang_abort");
    assert.equal(hangAbortBeforeSessionAbort, true);
    assert.equal(getTask(task.id)?.manualAbortedAssistantId, "");
    assert.equal(hangAbortManualId, "");
  });

  it("stops a queued Goal Loop before aborting an idle session", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-goal-abort-"));
    tempDirs.push(root);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "abort goal loop" });
    const sessionId = "goal-abort-session";
    const goalDir = join(root, ".pi", "goals-loop");
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
    const live = new Map([[task.id, {
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
    };

    await abortTask(task.id);

    assert.deepEqual(events, ["goal-stop", "abort"]);
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events,
    };

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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events,
    };

    await archiveTask(task.id);
    const restored = restoreTask(task.id);

    assert.equal(restored.status, "idle");
    assert.equal(getTask(task.id)?.status, "idle");
    assert.equal(emitted.at(-1)?.eventType, "restored");
    assert.equal(emitted.at(-1)?.status, "idle");
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
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
    };

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
    const live = new Map([[task.id, {
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
    };

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
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "reviewer.md"),
      "---\nname: reviewer\n---\n\nReview the work.\n",
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    const project = upsertProject({ name: "demo", rootPath: root });
    const task = insertTask({ project, title: "archive goal loop", agent: "build" });
    const sessionId = "archive-goal-session";
    const goalDir = join(root, ".pi", "goals-loop");
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
    const live = new Map([[task.id, {
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
    };

    await archiveTask(task.id);

    assert.deepEqual(events, ["goal-stop", "abort", "dispose"]);
    assert.equal(getTask(task.id)?.status, "archived");
    assert.equal(live.has(task.id), false);

    await assert.rejects(
      setTaskAgent(task.id, "reviewer"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 409 &&
        error.message.includes("アーカイブ"),
    );
    assert.equal(getTask(task.id)?.agent, "build");
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
    const live = new Map([[task.id, {
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
    };

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
    const goalDir = join(root, ".pi", "goals-loop");
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
    const live = new Map([[task.id, {
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
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      live,
      events: new EventEmitter(),
    };

    await destroyProject(project.id);

    assert.deepEqual(events, ["goal-stop", "abort", "dispose"]);
    assert.equal(getTask(task.id), undefined);
    assert.equal(getProject(project.id), undefined);
    assert.equal(live.has(task.id), false);
  });
});

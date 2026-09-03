import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { getTask, insertTask, upsertProject } from "@/lib/store";
import {
  armTaskHangWatch,
  getTaskHangWatch,
  stopHangWatchdogForTests,
} from "./hang-watchdog";
import { abortTask, setTaskAgent } from "./harness";

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

function fixture() {
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
  const live = new Map([[task.id, {
    accountId: null,
    session: {
      isStreaming: false,
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
  return { task, live, get disposed() { return disposed; }, get unsubscribed() { return unsubscribed; } };
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

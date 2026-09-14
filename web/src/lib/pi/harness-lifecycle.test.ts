import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTask, insertTask, patchTask, upsertProject } from "@/lib/store";
import { abortLiveForHangWatchdog, abortTask, isStaleHarnessPrompt, waitForSessionStreaming } from "./harness";
import { armTaskHangWatch, getTaskHangWatch, stopHangWatchdogForTests } from "./hang-watchdog";

const globalKey = "__leafcodePiHarness";
const globals = globalThis as Record<string, unknown>;
const previousHarness = globals[globalKey];
const roots: string[] = [];
afterEach(() => {
  stopHangWatchdogForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (previousHarness === undefined) delete globals[globalKey];
  else globals[globalKey] = previousHarness;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness lifecycle characterization", () => {
  it.each(["manual", "watchdog"] as const)("%s abort invalidates queued work immediately but publishes idle only after SDK settlement", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-harness-lifecycle-"));
    roots.push(root);
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    const project = upsertProject({ name: "contract", rootPath: root });
    const task = insertTask({ project, title: "Lifecycle" });
    patchTask(task.id, { status: "working" });
    let settle!: () => void;
    const pendingAbort = new Promise<void>((resolve) => { settle = resolve; });
    const order: string[] = [];
    const session = {
      sessionId: "contract-session", messages: [{ role: "user", content: "Summarize", timestamp: 1 }],
      agent: { state: { streamingMessage: undefined } }, isStreaming: true,
      sessionManager: { getLeafId: () => null, getBranch: () => [], getCwd: () => root },
      extensionRunner: { getCommand: () => undefined },
      clearQueue: () => { order.push("clear"); },
      abort: () => { order.push("abort"); return pendingAbort; },
    };
    const staleSnapshot = vi.fn();
    const live = {
      taskId: task.id, accountId: null, session, promptChain: Promise.resolve(),
      promptActive: true, promptEpoch: 7, skillPermission: "allow", skillPermissionRef: { current: "allow" },
      throughputByStartedAt: new Map(), persistedThroughputKeys: new Set(), toolStartedAt: new Map(),
      toolEndedAt: new Map(), toolPartialOutputByCallId: new Map(),
      snapshotTimer: setTimeout(staleSnapshot, 60_000), pendingSnapshotEventType: "message_update",
      pendingSnapshotIsDelta: true, pendingSnapshotExtra: { obsolete: true },
      revertLeafId: null, manualAbortedAssistantId: null, unsubscribe() {},
    };
    const events = new EventEmitter();
    const snapshots: Array<{ eventType?: string; task?: { status: string }; isStreaming?: boolean; permissionRequest?: unknown; questionRequest?: unknown }> = [];
    events.on(task.id, (event) => snapshots.push(event));
    globals[globalKey] = { live: new Map([[task.id, live]]), events };
    armTaskHangWatch({ taskId: task.id, prompt: "Summarize" });

    const stopping = kind === "manual" ? abortTask(task.id) : abortLiveForHangWatchdog(task.id);
    try {
      expect(order).toEqual(["clear", "abort"]);
      expect(live.promptActive).toBe(false);
      expect(live.promptEpoch).toBe(8);
      expect(isStaleHarnessPrompt(7, live.promptEpoch)).toBe(true);
      expect(live.snapshotTimer).toBeNull();
      expect(live.pendingSnapshotEventType).toBeNull();
      expect(live.pendingSnapshotExtra).toBeUndefined();
      expect(getTask(task.id)?.status).toBe("working");
      expect(getTask(task.id)?.manualAbortedAssistantId).toBe("");
      expect(snapshots.some((event) => event.task?.status === "idle")).toBe(false);
      expect(Boolean(getTaskHangWatch(task.id))).toBe(kind === "watchdog");
    } finally {
      settle();
      await stopping;
    }
    expect(staleSnapshot).not.toHaveBeenCalled();
    expect(getTask(task.id)?.status).toBe("idle");
    expect(snapshots.at(-1)).toMatchObject({
      eventType: kind === "manual" ? "abort" : "hang_idle",
      task: { status: "idle" }, isStreaming: false, permissionRequest: null, questionRequest: null,
    });
    expect(globals[globalKey]).toHaveProperty("live");
    // Watchdog abort preserves the retry request; manual stop must not revive it.
    expect(Boolean(getTaskHangWatch(task.id))).toBe(kind === "watchdog");
  });

  it("bounds the steer wait and accepts streaming observed at the deadline", async () => {
    vi.useFakeTimers();
    let streaming = false;
    const waiting = waitForSessionStreaming(() => streaming, () => true, { timeoutMs: 100, pollMs: 10 });
    await vi.advanceTimersByTimeAsync(90);
    streaming = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiting).toBe(true);
    const timeout = waitForSessionStreaming(() => false, () => true, { timeoutMs: 100, pollMs: 10 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await timeout).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting when abort invalidates the active prompt", async () => {
    vi.useFakeTimers();
    let active = true;
    const waiting = waitForSessionStreaming(() => false, () => active, { timeoutMs: 100, pollMs: 10 });
    active = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

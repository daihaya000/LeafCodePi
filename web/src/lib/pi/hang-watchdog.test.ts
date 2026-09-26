import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armTaskHangWatch,
  disarmTaskHangWatch,
  estimateWatchBodyBytes,
  MAX_HANG_RETRIES,
  MISSING_LIVE_GRACE_MS,
  getTaskHangWatch,
  progressFingerprint,
  recoverInterruptedHangWatches,
  registerHangWatchdogHooks,
  resolveHangNow,
  runHangWatchdogTick,
  stopHangWatchdogForTests,
  SUBAGENT_ACTIVE_GRACE_MS,
  turnHasOnlyActiveSubagentTool,
} from "./hang-watchdog";
import type { UiMessage } from "../types";

type ResumeCapture = {
  prompt: string;
  images?: { mimeType: string; data: string }[];
  isProviderFallback?: boolean;
};

const TIMEOUT_MS = 300_000;
const TICK_MS = 15_000;
/** Turn runs for 22 minutes, then the newest tool never finishes. */
const STALL_AT_MS = 1_320_000;

afterEach(() => {
  stopHangWatchdogForTests();
  vi.useRealTimers();
});

function activeToolMessage(tool: string): UiMessage {
  return {
    id: `${tool}-assistant`,
    role: "assistant",
    createdAt: 2,
    parts: [
      {
        id: `${tool}-part`,
        type: "tool",
        tool,
        callID: `${tool}-call`,
        state: { status: "running", input: {} },
      },
    ],
  };
}

function turnWithTools(...tools: string[]): UiMessage[] {
  return [
    {
      id: "prompt",
      role: "user",
      createdAt: 1,
      parts: [{ id: "prompt-text", type: "text", text: "作業" }],
    },
    {
      id: "assistant",
      role: "assistant",
      createdAt: 2,
      parts: tools.flatMap((tool) => activeToolMessage(tool).parts),
    },
  ];
}

function completedToolTurn(): UiMessage[] {
  return [
    {
      id: "prompt",
      role: "user",
      createdAt: 1,
      parts: [{ id: "prompt-text", type: "text", text: "作業" }],
    },
    {
      id: "assistant",
      role: "assistant",
      createdAt: 2,
      parts: [
        {
          id: "tool-part",
          type: "tool",
          tool: "powershell",
          callID: "tool-call",
          state: { status: "completed", output: "ok" },
        },
      ],
    },
  ];
}

function busyToolTurn(t: number, stallAt: number): UiMessage[] {
  const observed = Math.min(t, stallAt);
  const parts = [];
  for (let startedAt = 0; startedAt <= observed; startedAt += 20_000) {
    const running = startedAt + 20_000 > observed;
    parts.push({
      id: `tool-${startedAt}`,
      type: "tool" as const,
      tool: "powershell",
      callID: `call-${startedAt}`,
      state: running
        ? { status: "running" as const, startedAtMs: startedAt }
        : {
            status: "completed" as const,
            startedAtMs: startedAt,
            endedAtMs: startedAt + 10_000,
          },
    });
  }
  return [
    {
      id: "prompt",
      role: "user",
      createdAt: 0,
      parts: [{ id: "prompt-text", type: "text", text: "作業" }],
    },
    { id: "assistant", role: "assistant", createdAt: observed, parts },
  ];
}

function streamingToolTurn(startedAt: number, output: string): UiMessage[] {
  return [
    {
      id: "prompt",
      role: "user",
      createdAt: 0,
      parts: [{ id: "prompt-text", type: "text", text: "作業" }],
    },
    {
      id: "assistant",
      role: "assistant",
      createdAt: startedAt,
      parts: [
        {
          id: "tool-part",
          type: "tool",
          tool: "powershell",
          callID: "tool-call",
          state: { status: "running", startedAtMs: startedAt, output },
        },
      ],
    },
  ];
}

describe("hang-watchdog helpers", () => {
  it("estimates prompt and image payload size", () => {
    expect(
      estimateWatchBodyBytes({
        prompt: "hello",
        images: [{ mimeType: "image/png", data: "abcd" }],
      }),
    ).toBe(5 + 4 + "image/png".length);
  });

  it("builds a stable progress fingerprint", () => {
    const messages: UiMessage[] = [
      {
        id: "a1",
        role: "assistant",
        createdAt: 1,
        parts: [{ id: "t1", type: "text", text: "hi" }],
      },
    ];
    expect(progressFingerprint(messages)).toContain("assistant:a1:t:2");

    const running = (output: string): UiMessage[] => [
      {
        id: "a2",
        role: "assistant",
        createdAt: 1,
        parts: [
          {
            id: "tool-part",
            type: "tool",
            tool: "powershell",
            callID: "tool-call",
            state: { status: "running", output },
          },
        ],
      },
    ];
    expect(progressFingerprint(running("abc"))).toContain("o:running:3");
    expect(progressFingerprint(running("abcd"))).not.toBe(progressFingerprint(running("abc")));
    expect(progressFingerprint(running("abd"))).not.toBe(progressFingerprint(running("abc")));
    expect(progressFingerprint([{ ...messages[0]!, parts: [{ id: "t1", type: "text", text: "ok" }] }]))
      .not.toBe(progressFingerprint(messages));
  });

  it("rolls back watch changes when persistence fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-disarm-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "valid", prompt: "work" });
      const blocked = path.join(root, "not-a-directory");
      fs.writeFileSync(blocked, "blocked");
      process.env.LEAFCODE_PI_DATA_DIR = blocked;
      expect(() => disarmTaskHangWatch("valid")).toThrow();
      expect(getTaskHangWatch("valid")?.prompt).toBe("work");
      expect(() => armTaskHangWatch({ taskId: "valid", prompt: "replacement" })).toThrow();
      expect(getTaskHangWatch("valid")?.prompt).toBe("work");
      expect(() => armTaskHangWatch({ taskId: "new", prompt: "new work" })).toThrow();
      expect(getTaskHangWatch("new")).toBeNull();
      registerHangWatchdogHooks({
        getLive: () => null,
        abortTask: async () => undefined,
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      const before = getTaskHangWatch("valid")?.updatedAt;
      await expect(resolveHangNow("valid")).rejects.toThrow();
      expect(getTaskHangWatch("valid")).toMatchObject({ state: "armed", updatedAt: before });
      process.env.LEAFCODE_PI_DATA_DIR = root;
      expect(JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8")).watches).toHaveLength(1);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores resolving state when rearming cannot persist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-rearm-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    vi.useFakeTimers();
    try {
      armTaskHangWatch({ taskId: "rearm", prompt: "work" });
      const blocked = path.join(root, "not-a-directory");
      fs.writeFileSync(blocked, "blocked");
      const getLive = vi.fn(() => null);
      registerHangWatchdogHooks({
        getLive,
        abortTask: async () => { process.env.LEAFCODE_PI_DATA_DIR = blocked; },
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      const resolving = expect(resolveHangNow("rearm")).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(6_000);
      await resolving;
      expect(getLive).toHaveBeenCalledTimes(6);
      process.env.LEAFCODE_PI_DATA_DIR = root;
      const [saved] = JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8")).watches;
      expect(saved.state).toBe("resolving");
      expect(getTaskHangWatch("rearm")).toMatchObject({ state: "resolving", updatedAt: saved.updatedAt });
    } finally {
      stopHangWatchdogForTests();
      vi.useRealTimers();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores retry fields when persisting a resume fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-retry-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "retry", prompt: "work" });
      const blocked = path.join(root, "not-a-directory");
      fs.writeFileSync(blocked, "blocked");
      const resumePrompt = vi.fn();
      registerHangWatchdogHooks({
        getLive: () => {
          process.env.LEAFCODE_PI_DATA_DIR = blocked;
          return { messages: [], isStreaming: false, isCompacting: false };
        },
        abortTask: async () => undefined,
        resumePrompt,
        notifyHangRetry: () => undefined,
      });
      await expect(resolveHangNow("retry")).rejects.toThrow();
      expect(resumePrompt).not.toHaveBeenCalled();
      process.env.LEAFCODE_PI_DATA_DIR = root;
      const [saved] = JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8")).watches;
      expect(saved).toMatchObject({ state: "resolving", retryUsed: 0 });
      expect(getTaskHangWatch("retry")).toMatchObject(saved);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back sampled progress when persistence fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-progress-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "progress", prompt: "work" });
      const before = getTaskHangWatch("progress");
      const blocked = path.join(root, "not-a-directory");
      fs.writeFileSync(blocked, "blocked");
      const getLive = vi.fn(() => {
        process.env.LEAFCODE_PI_DATA_DIR = blocked;
        return { messages: [], isStreaming: true, isCompacting: false, hasPendingAttention: true };
      });
      registerHangWatchdogHooks({
        getLive,
        abortTask: async () => undefined,
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      await runHangWatchdogTick();
      expect(getLive).toHaveBeenCalledOnce();
      expect(getTaskHangWatch("progress")).toMatchObject({
        lastProgressAt: before?.lastProgressAt,
        progressFingerprint: before?.progressFingerprint,
        updatedAt: before?.updatedAt,
      });
      process.env.LEAFCODE_PI_DATA_DIR = root;
      expect(JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8")).watches).toHaveLength(1);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the missing-live clock when persistence fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-missing-save-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "missing-save", prompt: "work" });
      const before = getTaskHangWatch("missing-save")?.updatedAt;
      const blocked = path.join(root, "not-a-directory");
      fs.writeFileSync(blocked, "blocked");
      const getLive = vi.fn(() => {
        process.env.LEAFCODE_PI_DATA_DIR = blocked;
        return null;
      });
      registerHangWatchdogHooks({
        getLive,
        abortTask: async () => undefined,
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      await runHangWatchdogTick();
      expect(getLive).toHaveBeenCalledOnce();
      expect(getTaskHangWatch("missing-save")).toMatchObject({ updatedAt: before });
      expect(getTaskHangWatch("missing-save")?.missingLiveSince).toBeUndefined();
      process.env.LEAFCODE_PI_DATA_DIR = root;
      const [saved] = JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8")).watches;
      expect(saved.missingLiveSince).toBeUndefined();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the missing-live clock when reconnect persistence fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-reconnect-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "reconnect", prompt: "work" });
      const blocked = path.join(root, "not-a-directory");
      fs.writeFileSync(blocked, "blocked");
      let reconnected = false;
      const getLive = vi.fn(() => {
        if (!reconnected) return null;
        process.env.LEAFCODE_PI_DATA_DIR = blocked;
        return { messages: [], isStreaming: true, isCompacting: false };
      });
      registerHangWatchdogHooks({
        getLive,
        abortTask: async () => undefined,
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      await runHangWatchdogTick();
      const before = getTaskHangWatch("reconnect");
      expect(before?.missingLiveSince).toBeDefined();
      reconnected = true;
      await runHangWatchdogTick();
      expect(getLive).toHaveBeenCalledTimes(2);
      process.env.LEAFCODE_PI_DATA_DIR = root;
      const [saved] = JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8")).watches;
      expect(getTaskHangWatch("reconnect")).toMatchObject({
        missingLiveSince: saved.missingLiveSince,
        updatedAt: saved.updatedAt,
      });
      expect(saved.missingLiveSince).toBeDefined();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips corrupt persisted watches without losing valid ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-corrupt-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "valid", prompt: "work" });
      const file = path.join(root, "hang-watches.json");
      const store = JSON.parse(fs.readFileSync(file, "utf8"));
      store.watches[0].retryUsed = MAX_HANG_RETRIES;
      store.watches[0].state = "resolving";
      store.watches.push(null, { taskId: "", prompt: "bad" }, { taskId: "broken", prompt: "bad" });
      fs.writeFileSync(file, JSON.stringify(store));
      expect(() => recoverInterruptedHangWatches()).not.toThrow();
      expect(getTaskHangWatch("valid")).toMatchObject({
        prompt: "work", retryUsed: MAX_HANG_RETRIES, state: "armed",
      });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).watches).toHaveLength(1);
      expect(fs.readdirSync(root)).toEqual(["hang-watches.json"]);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a newer complete temp snapshot after an interrupted rename", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-temp-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      armTaskHangWatch({ taskId: "valid", prompt: "work" });
      const file = path.join(root, "hang-watches.json");
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      snapshot.watches[0].retryUsed = MAX_HANG_RETRIES;
      snapshot.watches[0].state = "resolving";
      const temp = `${file}.777.00000000-0000-4000-8000-000000000001.tmp`;
      fs.writeFileSync(temp, JSON.stringify(snapshot));
      fs.utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
      fs.utimesSync(temp, new Date("2032-01-01"), new Date("2032-01-01"));
      const older = `${file}.777.00000000-0000-4000-8000-000000000003.tmp`;
      const olderSnapshot = structuredClone(snapshot);
      olderSnapshot.watches[0].retryUsed = 1;
      fs.writeFileSync(older, JSON.stringify(olderSnapshot));
      fs.utimesSync(older, new Date("2031-01-01"), new Date("2031-01-01"));
      const torn = `${file}.777.00000000-0000-4000-8000-000000000002.tmp`;
      fs.writeFileSync(torn, '{"version":1,"watches":[null]}');
      fs.utimesSync(torn, new Date("2022-01-01"), new Date("2022-01-01"));
      recoverInterruptedHangWatches();
      expect(getTaskHangWatch("valid")).toMatchObject({ retryUsed: MAX_HANG_RETRIES, state: "armed" });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).watches[0].retryUsed).toBe(MAX_HANG_RETRIES);
      expect(fs.existsSync(temp)).toBe(false);
      expect(fs.existsSync(older)).toBe(false);
      expect(fs.existsSync(torn)).toBe(false);
      // A corrupt main file cannot outrank the last valid temp by mtime.
      fs.writeFileSync(temp, JSON.stringify(snapshot));
      fs.utimesSync(temp, new Date("2021-01-01"), new Date("2021-01-01"));
      fs.writeFileSync(file, "{truncated");
      fs.utimesSync(file, new Date("2023-01-01"), new Date("2023-01-01"));
      recoverInterruptedHangWatches();
      expect(getTaskHangWatch("valid")?.retryUsed).toBe(MAX_HANG_RETRIES);
      expect(fs.existsSync(temp)).toBe(false);
      armTaskHangWatch({ taskId: "valid", prompt: "new run" });
      recoverInterruptedHangWatches();
      expect(getTaskHangWatch("valid")).toMatchObject({ prompt: "new run", retryUsed: 0 });
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes a turn running only a subagent", () => {
    expect(turnHasOnlyActiveSubagentTool(turnWithTools("subagent"), 1)).toBe(true);
    expect(turnHasOnlyActiveSubagentTool(turnWithTools("task"), 1)).toBe(true);
    expect(turnHasOnlyActiveSubagentTool(turnWithTools("subagent", "powershell"), 1)).toBe(false);
    expect(turnHasOnlyActiveSubagentTool(turnWithTools("powershell"), 1)).toBe(false);
  });

  it("disarms a completed tool-only turn instead of treating it as a silent hang", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-completed-tool-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    const messages = completedToolTurn();
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages }),
      abortTask: async () => {
        throw new Error("completed turns must not be aborted");
      },
      resumePrompt: () => {
        throw new Error("completed turns must not be resumed");
      },
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "completed-tool-task", prompt: "作業", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      expect(getTaskHangWatch("completed-tool-task")).toBeNull();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not resolve a watch while context compaction is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-compacting-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let compacting = true;
    let abortCount = 0;
    let resumeCount = 0;
    const messages: UiMessage[] = [
      {
        id: "prompt",
        role: "user",
        createdAt: 1_000_000,
        parts: [{ id: "prompt-text", type: "text", text: "作業" }],
      },
    ];
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: compacting, messages }),
      abortTask: async () => {
        abortCount += 1;
        compacting = false;
      },
      resumePrompt: () => {
        resumeCount += 1;
      },
      notifyHangRetry: () => undefined,
    });
    try {
      fs.writeFileSync(
        path.join(root, "web-settings.json"),
        JSON.stringify({ version: 1, "hang-timeout": 60_000 }),
        "utf8",
      );
      armTaskHangWatch({ taskId: "compacting-task", prompt: "作業", startedAt: 1_000_000 });
      vi.setSystemTime(1_100_000);
      await runHangWatchdogTick();
      vi.setSystemTime(1_200_000);
      await runHangWatchdogTick();

      expect(abortCount).toBe(0);
      expect(resumeCount).toBe(0);
      expect(getTaskHangWatch("compacting-task")?.state).toBe("armed");
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not revive a watch that was explicitly disarmed while abort was in flight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-cancelled-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let releaseAbort!: () => void;
    const abortFinished = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    let resumeCount = 0;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages: [] }),
      abortTask: async () => {
        await abortFinished;
      },
      resumePrompt: () => {
        resumeCount += 1;
      },
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "cancelled-task", prompt: "作業" });
      const resolving = resolveHangNow("cancelled-task");
      disarmTaskHangWatch("cancelled-task");
      releaseAbort();
      await resolving;
      expect(resumeCount).toBe(0);
      expect(getTaskHangWatch("cancelled-task")).toBeNull();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops an orphaned watch after the live-session grace period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-missing-live-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let reason = "";
    registerHangWatchdogHooks({
      getLive: () => null,
      abortTask: async () => undefined,
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
      onMissingLive: (_taskId, message) => {
        reason = message;
      },
    });
    try {
      armTaskHangWatch({ taskId: "missing-live", prompt: "work", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      expect(getTaskHangWatch("missing-live")?.missingLiveSince).toBe(1_000_000);
      vi.setSystemTime(1_000_000 + MISSING_LIVE_GRACE_MS);
      await runHangWatchdogTick();
      expect(getTaskHangWatch("missing-live")).toBeNull();
      expect(reason).toContain("live session disappeared");
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores missing-live grace when a foreign-lease reset cannot persist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-lease-save-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.mkdirSync(path.join(root, "task-leases"), { recursive: true });
    fs.writeFileSync(path.join(root, "task-leases", "lease-save.json"), `${JSON.stringify({
      token: "other-worker", pid: process.pid, acquiredAt: 1_000_000, heartbeatAt: 1_000_000,
    })}\n`);
    const file = path.join(root, "hang-watches.json");
    let blockSave = false;
    const getLive = vi.fn(() => {
      if (blockSave) {
        fs.renameSync(file, `${file}.saved`);
        fs.mkdirSync(file);
        blockSave = false;
      }
      return null;
    });
    registerHangWatchdogHooks({
      getLive,
      abortTask: async () => undefined,
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "lease-save", prompt: "work", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      expect(getTaskHangWatch("lease-save")?.missingLiveSince).toBe(1_000_000);
      vi.setSystemTime(1_000_000 + MISSING_LIVE_GRACE_MS);
      blockSave = true;
      await runHangWatchdogTick();
      expect(getLive).toHaveBeenCalledTimes(2);
      const [saved] = JSON.parse(fs.readFileSync(`${file}.saved`, "utf8")).watches;
      expect(getTaskHangWatch("lease-save")).toMatchObject({
        missingLiveSince: saved.missingLiveSince,
        updatedAt: saved.updatedAt,
      });
      expect(saved.missingLiveSince).toBe(1_000_000);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a watch when another worker holds the active lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-foreign-lease-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.mkdirSync(path.join(root, "task-leases"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "task-leases", "foreign-lease.json"),
      `${JSON.stringify({
        token: "other-worker",
        pid: process.pid,
        acquiredAt: 1_000_000,
        heartbeatAt: 1_000_000,
      })}\n`,
      "utf8",
    );
    let reason = "";
    registerHangWatchdogHooks({
      getLive: () => null,
      abortTask: async () => undefined,
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
      onMissingLive: (_taskId, message) => {
        reason = message;
      },
    });
    try {
      armTaskHangWatch({ taskId: "foreign-lease", prompt: "work", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      expect(getTaskHangWatch("foreign-lease")?.missingLiveSince).toBe(1_000_000);
      vi.setSystemTime(1_000_000 + MISSING_LIVE_GRACE_MS);
      await runHangWatchdogTick();
      expect(getTaskHangWatch("foreign-lease")).not.toBeNull();
      expect(getTaskHangWatch("foreign-lease")?.missingLiveSince).toBeUndefined();
      expect(reason).toBe("");
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restarts missing-live grace after a foreign lease is released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-lease-handoff-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    const leaseFile = path.join(root, "task-leases", "lease-handoff.json");
    fs.mkdirSync(path.join(root, "task-leases"), { recursive: true });
    fs.writeFileSync(
      leaseFile,
      `${JSON.stringify({
        token: "other-worker",
        pid: process.pid,
        acquiredAt: 1_000_000,
        heartbeatAt: 1_000_000,
      })}\n`,
      "utf8",
    );
    let reason = "";
    registerHangWatchdogHooks({
      getLive: () => null,
      abortTask: async () => undefined,
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
      onMissingLive: (_taskId, message) => {
        reason = message;
      },
    });
    try {
      armTaskHangWatch({ taskId: "lease-handoff", prompt: "work", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      vi.setSystemTime(1_000_000 + MISSING_LIVE_GRACE_MS);
      await runHangWatchdogTick();
      expect(getTaskHangWatch("lease-handoff")?.missingLiveSince).toBeUndefined();

      fs.unlinkSync(leaseFile);
      await runHangWatchdogTick();
      expect(getTaskHangWatch("lease-handoff")?.missingLiveSince).toBe(1_000_000 + MISSING_LIVE_GRACE_MS);
      expect(reason).toBe("");

      vi.setSystemTime(1_000_000 + MISSING_LIVE_GRACE_MS * 2);
      await runHangWatchdogTick();
      expect(getTaskHangWatch("lease-handoff")).toBeNull();
      expect(reason).toContain("live session disappeared");
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not abort a parent turn while its only active tool is a subagent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "hang-timeout": 60_000 }),
      "utf8",
    );
    const messages = turnWithTools("subagent");
    let abortCount = 0;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: true, isCompacting: false, messages }),
      abortTask: async () => {
        abortCount += 1;
      },
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "task-1", prompt: "作業", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      vi.setSystemTime(1_100_000);
      await runHangWatchdogTick();

      expect(abortCount).toBe(0);
      expect(getTaskHangWatch("task-1")?.progressFingerprint).toBe("");
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts a parent turn when a subagent-only tool stays stuck past grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-subagent-grace-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "hang-timeout": 60_000 }),
      "utf8",
    );
    const messages = turnWithTools("subagent");
    let abortCount = 0;
    registerHangWatchdogHooks({
      getLive: () => ({
        isStreaming: abortCount === 0,
        isCompacting: false,
        messages,
      }),
      abortTask: async () => {
        abortCount += 1;
      },
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "task-subagent-stuck", prompt: "作業", startedAt: 1_000_000 });
      await runHangWatchdogTick();
      expect(abortCount).toBe(0);
      vi.setSystemTime(1_000_000 + SUBAGENT_ACTIVE_GRACE_MS + 1);
      const hanging = runHangWatchdogTick();
      await vi.advanceTimersByTimeAsync(5_000);
      await hanging;
      expect(abortCount).toBe(1);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not abort while a permission or question prompt is waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-pending-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "hang-timeout": 60_000 }),
      "utf8",
    );
    const messages = turnWithTools("powershell");
    let abortCount = 0;
    registerHangWatchdogHooks({
      getLive: () => ({
        isStreaming: true,
        isCompacting: false,
        messages,
        hasPendingAttention: true,
      }),
      abortTask: async () => {
        abortCount += 1;
      },
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "task-pending", prompt: "作業", startedAt: 1 });
      await runHangWatchdogTick();
      vi.setSystemTime(1_200_000);
      await runHangWatchdogTick();

      expect(abortCount).toBe(0);
      expect(getTaskHangWatch("task-pending")).not.toBeNull();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("arms an image-only prompt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-image-only-arm-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    try {
      const images = [{ mimeType: "image/png", data: "abc" }];
      armTaskHangWatch({ taskId: "image-only", prompt: "", images });
      expect(getTaskHangWatch("image-only")?.images).toEqual(images);
      armTaskHangWatch({ taskId: "empty", prompt: "   " });
      expect(getTaskHangWatch("empty")).toBeNull();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps image-only attachments when hang-resume mode is continue", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-image-continue-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "auto-resume-mode": "continue" }),
      "utf8",
    );
    const images = [{ mimeType: "image/png", data: "abc" }];
    // Assertion prevents CFA from narrowing to null across the resume callback.
    let resumed = null as ResumeCapture | null;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages: [] }),
      abortTask: async () => undefined,
      resumePrompt: (_taskId, input) => {
        resumed = input;
      },
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({
        taskId: "image-continue",
        prompt: "",
        images,
        isProviderFallback: true,
      });
      await resolveHangNow("image-continue");
      expect(resumed?.images).toEqual(images);
      expect(resumed?.prompt).toContain("続けて");
      expect(resumed?.isProviderFallback).toBe(true);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops images on continue resume when the original prompt had text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-text-continue-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "auto-resume-mode": "continue" }),
      "utf8",
    );
    const images = [{ mimeType: "image/png", data: "abc" }];
    let resumed = null as ResumeCapture | null;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages: [] }),
      abortTask: async () => undefined,
      resumePrompt: (_taskId, input) => {
        resumed = input;
      },
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "text-continue", prompt: "見て", images });
      await resolveHangNow("text-continue");
      expect(resumed?.images).toEqual([]);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts Goal Loop hangs without resuming via queuePrompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-goal-skip-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let resumed = 0;
    let aborted = 0;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages: [] }),
      abortTask: async () => {
        aborted += 1;
      },
      resumePrompt: () => {
        resumed += 1;
      },
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({
        taskId: "goal-skip",
        prompt: "<!-- webui-goal-loop-prompt --> continue the goal",
        skipResume: true,
      });
      await resolveHangNow("goal-skip");
      expect(aborted).toBe(1);
      expect(resumed).toBe(0);
      expect(getTaskHangWatch("goal-skip")).toBeNull();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts a stalled tool one timeout after the last progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-stall-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "hang-timeout": TIMEOUT_MS }),
      "utf8",
    );
    let messages: UiMessage[] = busyToolTurn(0, STALL_AT_MS);
    const abortTimes: number[] = [];
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages }),
      abortTask: async () => {
        abortTimes.push(Date.now());
      },
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "stalled-tool", prompt: "作業", startedAt: 0 });
      for (let t = 0; t <= STALL_AT_MS + 2 * TIMEOUT_MS; t += TICK_MS) {
        vi.setSystemTime(t);
        messages = busyToolTurn(t, STALL_AT_MS);
        await runHangWatchdogTick();
        if (abortTimes.length > 0) break;
      }

      expect(abortTimes).toEqual([STALL_AT_MS + TIMEOUT_MS]);
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a running tool alive while it keeps printing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-streaming-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    fs.writeFileSync(
      path.join(root, "web-settings.json"),
      JSON.stringify({ version: 1, "hang-timeout": TIMEOUT_MS }),
      "utf8",
    );
    let messages: UiMessage[] = streamingToolTurn(0, "");
    let abortCount = 0;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages }),
      abortTask: async () => {
        abortCount += 1;
      },
      resumePrompt: () => undefined,
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "streaming-tool", prompt: "作業", startedAt: 0 });
      for (let t = 0; t <= 3 * TIMEOUT_MS; t += TICK_MS) {
        vi.setSystemTime(t);
        messages = streamingToolTurn(0, "x".repeat(t / 1_000));
        await runHangWatchdogTick();
      }

      expect(abortCount).toBe(0);
      expect(getTaskHangWatch("streaming-tool")?.state).toBe("armed");
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops auto-resume after MAX_HANG_RETRIES", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-cap-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let resumed = 0;
    registerHangWatchdogHooks({
      getLive: () => ({ isStreaming: false, isCompacting: false, messages: [] }),
      abortTask: async () => undefined,
      resumePrompt: () => {
        resumed += 1;
      },
      notifyHangRetry: () => undefined,
    });
    try {
      armTaskHangWatch({ taskId: "cap", prompt: "keep going" });
      for (let i = 0; i < MAX_HANG_RETRIES; i += 1) {
        await resolveHangNow("cap");
      }
      expect(resumed).toBe(MAX_HANG_RETRIES);
      expect(getTaskHangWatch("cap")?.retryUsed).toBe(MAX_HANG_RETRIES);
      await resolveHangNow("cap");
      expect(resumed).toBe(MAX_HANG_RETRIES);
      expect(getTaskHangWatch("cap")).toBeNull();
    } finally {
      stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves watches armed by separate worker instances", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-multiwriter-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let first: typeof import("./hang-watchdog") | undefined;
    let second: typeof import("./hang-watchdog") | undefined;
    try {
      vi.resetModules();
      first = await import("./hang-watchdog");
      vi.resetModules();
      second = await import("./hang-watchdog");
      first.armTaskHangWatch({ taskId: "first", prompt: "work" });
      second.armTaskHangWatch({ taskId: "second", prompt: "work" });
      const file = path.join(root, "hang-watches.json");
      const store = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(store.watches.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["first", "second"]);
      first.disarmTaskHangWatch("first");
      const remaining = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(remaining.watches.map((row: { taskId: string }) => row.taskId)).toEqual(["second"]);
      const getLive = vi.fn(() => {
        first!.armTaskHangWatch({ taskId: "third", prompt: "work" });
        return { messages: [], isStreaming: true, isCompacting: false, hasPendingAttention: true };
      });
      second.registerHangWatchdogHooks({
        getLive,
        abortTask: async () => undefined,
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      await second.runHangWatchdogTick();
      expect(getLive).toHaveBeenCalledOnce();
      const afterProgress = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(afterProgress.watches.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["second", "third"]);
      let duringAbort: { taskId: string; state: string }[] = [];
      second.registerHangWatchdogHooks({
        getLive: () => ({ messages: [], isStreaming: false, isCompacting: false }),
        abortTask: async () => {
          duringAbort = JSON.parse(fs.readFileSync(file, "utf8")).watches;
          second!.disarmTaskHangWatch("second");
        },
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      await second.resolveHangNow("second");
      expect(duringAbort.map((row) => row.taskId).sort()).toEqual(["second", "third"]);
      expect(duringAbort.find((row) => row.taskId === "second")?.state).toBe("resolving");
      vi.useFakeTimers();
      first.registerHangWatchdogHooks({
        getLive: () => null,
        abortTask: async () => { second!.armTaskHangWatch({ taskId: "fourth", prompt: "work" }); },
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      const settling = first.resolveHangNow("third");
      await vi.advanceTimersByTimeAsync(6_000);
      await settling;
      const afterRearm = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(afterRearm.watches.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["fourth", "third"]);
      expect(afterRearm.watches.find((row: { taskId: string }) => row.taskId === "third")?.state).toBe("armed");
      const resumePrompt = vi.fn();
      first.registerHangWatchdogHooks({
        getLive: () => ({ messages: [], isStreaming: false, isCompacting: false }),
        abortTask: async () => { second!.armTaskHangWatch({ taskId: "fifth", prompt: "work" }); },
        resumePrompt,
        notifyHangRetry: () => undefined,
      });
      await first.resolveHangNow("third");
      expect(resumePrompt).toHaveBeenCalledOnce();
      const afterRetry = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(afterRetry.watches.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["fifth", "fourth", "third"]);
      expect(afterRetry.watches.find((row: { taskId: string }) => row.taskId === "third")?.retryUsed).toBe(1);
    } finally {
      first?.stopHangWatchdogForTests();
      second?.stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves another worker's watch when recording missing-live grace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-hang-watchdog-multi-grace-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = root;
    let first: typeof import("./hang-watchdog") | undefined;
    let second: typeof import("./hang-watchdog") | undefined;
    try {
      vi.resetModules();
      first = await import("./hang-watchdog");
      vi.resetModules();
      second = await import("./hang-watchdog");
      first.armTaskHangWatch({ taskId: "first", prompt: "work" });
      const getLive = vi.fn(() => {
        second!.armTaskHangWatch({ taskId: "second", prompt: "work" });
        return null;
      });
      first.registerHangWatchdogHooks({
        getLive,
        abortTask: async () => undefined,
        resumePrompt: () => undefined,
        notifyHangRetry: () => undefined,
      });
      await first.runHangWatchdogTick();
      expect(getLive).toHaveBeenCalledOnce();
      const store = JSON.parse(fs.readFileSync(path.join(root, "hang-watches.json"), "utf8"));
      expect(store.watches.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["first", "second"]);
      expect(store.watches.find((row: { taskId: string }) => row.taskId === "first")?.missingLiveSince).toBeDefined();
    } finally {
      first?.stopHangWatchdogForTests();
      second?.stopHangWatchdogForTests();
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armTaskHangWatch,
  disarmTaskHangWatch,
  estimateWatchBodyBytes,
  MISSING_LIVE_GRACE_MS,
  getTaskHangWatch,
  progressFingerprint,
  registerHangWatchdogHooks,
  resolveHangNow,
  runHangWatchdogTick,
  stopHangWatchdogForTests,
  turnHasOnlyActiveSubagentTool,
} from "./hang-watchdog";
import type { UiMessage } from "../types";

type ResumeCapture = {
  prompt: string;
  images?: { mimeType: string; data: string }[];
};

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
      armTaskHangWatch({ taskId: "task-1", prompt: "作業", startedAt: 1 });
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
      armTaskHangWatch({ taskId: "image-continue", prompt: "", images });
      await resolveHangNow("image-continue");
      expect(resumed?.images).toEqual(images);
      expect(resumed?.prompt).toContain("続けて");
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
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armTaskHangWatch,
  estimateWatchBodyBytes,
  getTaskHangWatch,
  progressFingerprint,
  registerHangWatchdogHooks,
  runHangWatchdogTick,
  stopHangWatchdogForTests,
  turnHasOnlyActiveSubagentTool,
} from "./hang-watchdog";
import type { UiMessage } from "../types";

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
});

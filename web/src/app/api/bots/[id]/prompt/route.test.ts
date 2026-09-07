import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ promptTask: vi.fn(), goalLoopCommand: vi.fn() }));
vi.mock("../../../../../lib/pi/harness", () => ({
  promptTask: state.promptTask,
  goalLoopCommand: state.goalLoopCommand,
  jsonError: (error: Error) => ({ error: error.message, status: 500 }),
}));

import { createBot, patchBot } from "../../../../../lib/bots";
import { POST } from "./route";

function request(prompt: unknown, goalLoop?: unknown): NextRequest {
  return new NextRequest("http://localhost", {
    method: "POST",
    body: JSON.stringify({ prompt, ...(goalLoop === undefined ? {} : { goalLoop }) }),
  });
}

describe("POST /api/bots/[id]/prompt", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-bot-prompt-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
    state.promptTask.mockResolvedValue({ status: "working" });
    state.goalLoopCommand.mockResolvedValue({ id: "loop-1", status: "queued" });
  });

  afterEach(() => {
    state.promptTask.mockReset();
    state.goalLoopCommand.mockReset();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps direct 1:1 messaging available when the bot is disabled for rooms", async () => {
    const bot = createBot({ name: "Direct bot" });
    patchBot(bot.id, { enabled: false });

    const response = await POST(request("hello"), {
      params: Promise.resolve({ id: bot.id }),
    });

    expect(response.status).toBe(200);
    expect(state.promptTask).toHaveBeenCalledWith(`bot:${bot.id}`, "hello");
  });

  it("starts Goal Loop through the existing command path", async () => {
    const bot = createBot({ name: "Loop bot" });

    const response = await POST(
      request("調査して修正する", {
        acceptance: ["テストが通る"],
        maxTurns: 2,
        cooldownSeconds: 30,
        forceFullRun: true,
      }),
      { params: Promise.resolve({ id: bot.id }) },
    );

    expect(response.status).toBe(200);
    expect(state.goalLoopCommand).toHaveBeenCalledWith(`bot:${bot.id}`, {
      action: "start",
      goal: "調査して修正する",
      acceptance: ["テストが通る"],
      maxTurns: 2,
      cooldownSeconds: 30,
      forceFullRun: true,
    });
    expect(state.promptTask).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      task: null,
      loop: { id: "loop-1", status: "queued" },
    });
  });
});

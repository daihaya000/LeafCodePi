import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  destroyTask: vi.fn(),
  resetTaskConversation: vi.fn(async (id: string) => ({ id })),
  stopRoomTurns: vi.fn(async () => 0),
  cancelPendingRoomHandoffs: vi.fn(() => 0),
  stopAllRoomCodeSessions: vi.fn(async () => 0),
  detachBotFromRoomRuntime: vi.fn(async () => undefined),
}));
vi.mock("@/lib/pi/harness", () => ({
  destroyTask: state.destroyTask,
  resetTaskConversation: state.resetTaskConversation,
}));
vi.mock("@/lib/room-runtime", () => ({
  stopRoomTurns: state.stopRoomTurns,
  cancelPendingRoomHandoffs: state.cancelPendingRoomHandoffs,
  detachBotFromRoomRuntime: state.detachBotFromRoomRuntime,
}));
vi.mock("@/lib/pi/bot-code-relay", () => ({
  stopAllRoomCodeSessions: state.stopAllRoomCodeSessions,
}));

import { createBot } from "@/lib/bots";
import { appendRoomMessage, createRoom, ensureRoomBotTask, getRoom } from "@/lib/rooms";
import { getTask } from "@/lib/store";
import { DELETE, PATCH } from "./route";

describe("DELETE /api/bots/rooms/[id]", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-room-delete-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
  });

  afterEach(() => {
    state.destroyTask.mockReset();
    state.resetTaskConversation.mockClear();
    state.stopRoomTurns.mockClear();
    state.cancelPendingRoomHandoffs.mockClear();
    state.stopAllRoomCodeSessions.mockClear();
    state.detachBotFromRoomRuntime.mockClear();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("destroys existing room tasks before deleting the room", async () => {
    const bot = createBot({ name: "Room bot" });
    const room = createRoom({ members: [bot.id] });
    const taskId = ensureRoomBotTask(room, bot);

    const response = await DELETE(new NextRequest("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ id: room.id }),
    });

    expect(response.status).toBe(200);
    expect(state.stopRoomTurns).toHaveBeenCalledWith(room.id);
    expect(state.cancelPendingRoomHandoffs).toHaveBeenCalledWith(room.id);
    expect(state.stopAllRoomCodeSessions).toHaveBeenCalledWith(room.id);
    expect(state.destroyTask).toHaveBeenCalledWith(taskId);
    expect(getTask(taskId)).toBeUndefined();
  });
});

describe("PATCH /api/bots/rooms/[id] resetMessages", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-room-reset-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
    state.resetTaskConversation.mockClear();
    state.stopRoomTurns.mockClear();
    state.cancelPendingRoomHandoffs.mockClear();
    state.stopAllRoomCodeSessions.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("stops turns, cancels Code outbox, and resets member sessions before clearing messages", async () => {
    const bot = createBot({ name: "Room bot" });
    const room = createRoom({ members: [bot.id] });
    const taskId = ensureRoomBotTask(room, bot);
    appendRoomMessage(room.id, { role: "user", text: "残作業も進めて" });

    const response = await PATCH(
      new NextRequest("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ resetMessages: true }),
      }),
      { params: Promise.resolve({ id: room.id }) },
    );

    expect(response.status).toBe(200);
    expect(state.stopRoomTurns).toHaveBeenCalledWith(room.id);
    expect(state.cancelPendingRoomHandoffs).toHaveBeenCalledWith(room.id);
    expect(state.stopAllRoomCodeSessions).toHaveBeenCalledWith(room.id);
    expect(state.resetTaskConversation).toHaveBeenCalledWith(taskId);
    expect(getRoom(room.id)?.messages).toEqual([]);
  });

  it("detaches removed members before patching membership", async () => {
    const alpha = createBot({ name: "Alpha" });
    const beta = createBot({ name: "Beta" });
    const room = createRoom({ members: [alpha.id, beta.id] });

    const response = await PATCH(
      new NextRequest("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ members: [alpha.id] }),
      }),
      { params: Promise.resolve({ id: room.id }) },
    );

    expect(response.status).toBe(200);
    expect(state.detachBotFromRoomRuntime).toHaveBeenCalledWith(room.id, beta.id);
    expect(state.detachBotFromRoomRuntime).not.toHaveBeenCalledWith(room.id, alpha.id);
    expect(getRoom(room.id)?.members).toEqual([alpha.id]);
  });
});

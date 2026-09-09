import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRequest } from "@/lib/pi/bot-code-relay";

const state = vi.hoisted(() => ({ root: "", stopBotCodeTask: vi.fn(), pendingRoom: vi.fn<(roomId: string) => CodeRequest | undefined>(() => undefined), roomRequest: vi.fn<(roomId: string, requestId: string) => CodeRequest | undefined>(() => undefined), cancelRoom: vi.fn<(roomId: string, requestId: string) => boolean>(() => false) }));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({ stopBotCodeTask: state.stopBotCodeTask, jsonError: (error: Error) => ({ error: error.message, status: 500 }) }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ pendingRoomCodeRequestForRoom: state.pendingRoom, roomCodeRequestForRoom: state.roomRequest, cancelRoomCodeRequest: state.cancelRoom }));

import { createRoom } from "@/lib/rooms";
import { POST } from "./route";

function send(id: string, body: unknown) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-code-"));
  state.stopBotCodeTask.mockResolvedValue({ id: "code-1", status: "idle" });
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.stopBotCodeTask.mockReset();
  state.pendingRoom.mockReset();
  state.roomRequest.mockReset();
  state.cancelRoom.mockReset();
});

describe("room Code control", () => {
  it("stops the Room's running Code request", async () => {
    const room = createRoom({ name: "Team" });
    state.pendingRoom.mockReturnValue({ id: "request", botId: "bot-1", codeTaskId: "code-1", room: { id: room.id } } as CodeRequest);
    const result = await send(room.id, { action: "abort" });
    expect(result.status).toBe(200);
    // Marks the request as user-stopped before aborting, so the Bot cannot continue it by itself.
    expect(state.stopBotCodeTask).toHaveBeenCalledWith("bot-1", "code-1");
  });

  it("cancels a queued Room Code request without starting a task", async () => {
    const room = createRoom({ name: "Team" });
    const queued = { id: "queued", botId: "bot-1", originTaskId: "bot:bot-1:room:" + room.id, state: "queued", codeTaskId: null, prompt: "wait", baseline: null, room: { id: room.id } } as CodeRequest;
    state.roomRequest.mockReturnValue(queued);
    state.cancelRoom.mockReturnValue(true);
    const result = await send(room.id, { action: "abort", requestId: "queued" });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ requestId: "queued", state: "cancelled" });
    expect(state.cancelRoom).toHaveBeenCalledWith(room.id, "queued");
    expect(state.stopBotCodeTask).not.toHaveBeenCalled();
  });

  it("rejects an unknown room, an unsupported action, and a room with nothing running", async () => {
    const room = createRoom({ name: "Team" });
    expect((await send("missing", { action: "abort" })).status).toBe(404);
    expect((await send(room.id, { action: "start" })).status).toBe(400);
    expect((await send(room.id, { action: "abort" })).status).toBe(404);
    expect(state.stopBotCodeTask).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRequest } from "@/lib/pi/bot-code-relay";

const state = vi.hoisted(() => ({ root: "", abortTask: vi.fn(), pendingRoom: vi.fn<(roomId: string) => CodeRequest | undefined>(() => undefined), roomRequest: vi.fn<(roomId: string, requestId: string) => CodeRequest | undefined>(() => undefined), stopRequest: vi.fn() }));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({ abortTask: state.abortTask, jsonError: (error: Error) => ({ error: error.message, status: 500 }) }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ pendingRoomCodeRequestForRoom: state.pendingRoom, roomCodeRequestForRoom: state.roomRequest, stopBotCodeRequest: state.stopRequest }));

import { createRoom } from "@/lib/rooms";
import { POST } from "./route";

function send(id: string, body: unknown) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-code-"));
  state.abortTask.mockResolvedValue({ id: "code-1", status: "idle" });
  state.stopRequest.mockResolvedValue({ state: "running", codeTaskId: "code-1" });
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.abortTask.mockReset();
  state.pendingRoom.mockReset();
  state.roomRequest.mockReset();
  state.stopRequest.mockReset();
});

describe("room Code control", () => {
  it("stops the Room's running Code request", async () => {
    const room = createRoom({ name: "Team" });
    state.pendingRoom.mockReturnValue({ id: "request", botId: "bot-1", codeTaskId: "code-1", room: { id: room.id } } as CodeRequest);
    const result = await send(room.id, { action: "abort" });
    expect(result.status).toBe(200);
    // Marks the request as user-stopped before aborting, so the Bot cannot continue it by itself.
    expect(state.stopRequest).toHaveBeenCalledWith("bot-1", "request");
    expect(state.abortTask).toHaveBeenCalledWith("code-1");
  });

  it.each(["starting", "queued"])("cancels an unlaunched %s request by its own id", async (status) => {
    const room = createRoom({ name: "Team" });
    state.roomRequest.mockReturnValue({ id: "request-2", botId: "bot-1", state: status, codeTaskId: null, room: { id: room.id } } as CodeRequest);
    state.stopRequest.mockResolvedValue({ state: "cancelled", codeTaskId: null });
    const result = await send(room.id, { action: "abort", requestId: "request-2" });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ requestId: "request-2", state: "cancelled" });
    expect(state.roomRequest).toHaveBeenCalledWith(room.id, "request-2");
    expect(state.stopRequest).toHaveBeenCalledWith("bot-1", "request-2");
    expect(state.abortTask).not.toHaveBeenCalled();
  });

  it("never falls back to a sibling when the specified request is unknown", async () => {
    const room = createRoom({ name: "Team" });
    state.pendingRoom.mockReturnValue({ id: "sibling", codeTaskId: "code-1" } as CodeRequest);
    expect((await send(room.id, { action: "abort", requestId: "foreign" })).status).toBe(404);
    expect(state.stopRequest).not.toHaveBeenCalled();
    expect(state.abortTask).not.toHaveBeenCalled();
  });

  it("rejects an unknown room, an unsupported action, and a room with nothing running", async () => {
    const room = createRoom({ name: "Team" });
    expect((await send("missing", { action: "abort" })).status).toBe(404);
    expect((await send(room.id, { action: "start" })).status).toBe(400);
    expect((await send(room.id, { action: "abort" })).status).toBe(404);
    expect(state.abortTask).not.toHaveBeenCalled();
  });
});

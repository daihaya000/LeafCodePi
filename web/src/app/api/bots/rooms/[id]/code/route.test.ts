import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRequest } from "@/lib/pi/bot-code-relay";

const state = vi.hoisted(() => ({ root: "", abortTaskIncludingColdGoalLoop: vi.fn(), completeBotCodeRequest: vi.fn(), pendingRoom: vi.fn<(roomId: string) => CodeRequest | undefined>(() => undefined), roomRequest: vi.fn<(roomId: string, requestId: string) => CodeRequest | undefined>(() => undefined), stopRequest: vi.fn(), localRuntimeBlocked: vi.fn(() => false), forwardBotCodeRequestAbort: vi.fn() }));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({ abortTaskIncludingColdGoalLoop: state.abortTaskIncludingColdGoalLoop, completeBotCodeRequest: state.completeBotCodeRequest, jsonError: (error: Error) => ({ error: error.message, status: 500 }) }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ pendingRoomCodeRequestForRoom: state.pendingRoom, roomCodeRequestForRoom: state.roomRequest, stopBotCodeRequest: state.stopRequest }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: state.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardBotCodeRequestAbort: state.forwardBotCodeRequestAbort,
  forwardGoalLoopControl: vi.fn(),
  forwardTaskAbort: vi.fn(),
  forwardTaskDetail: vi.fn(),
  forwardTaskPrompt: vi.fn(),
  forwardPermissionAnswer: vi.fn(),
  forwardQuestionAnswer: vi.fn(),
  forwardTaskPendingRequests: vi.fn(),
  forwardPendingRequestsByTask: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

import { createRoom } from "@/lib/rooms";
import { POST } from "./route";

function send(id: string, body: unknown) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-code-"));
  state.abortTaskIncludingColdGoalLoop.mockResolvedValue({ id: "code-1", status: "idle" });
  state.stopRequest.mockResolvedValue({ state: "running", codeTaskId: "code-1" });
  state.localRuntimeBlocked.mockReset();
  state.localRuntimeBlocked.mockReturnValue(false);
  state.forwardBotCodeRequestAbort.mockReset();
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.abortTaskIncludingColdGoalLoop.mockReset();
  state.completeBotCodeRequest.mockReset();
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
    expect(state.abortTaskIncludingColdGoalLoop).toHaveBeenCalledWith("code-1");
    expect(state.completeBotCodeRequest).toHaveBeenCalledWith("request");
  });

  it("still completes the outbox when abort fails after stop", async () => {
    const room = createRoom({ name: "Team" });
    state.pendingRoom.mockReturnValue({ id: "request", botId: "bot-1", codeTaskId: "code-1", room: { id: room.id } } as CodeRequest);
    state.abortTaskIncludingColdGoalLoop.mockRejectedValueOnce(new Error("abort failed"));
    const result = await send(room.id, { action: "abort" });
    expect(result.status).toBe(500);
    expect(state.completeBotCodeRequest).toHaveBeenCalledWith("request");
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
    expect(state.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });

  it("never falls back to a sibling when the specified request is unknown", async () => {
    const room = createRoom({ name: "Team" });
    state.pendingRoom.mockReturnValue({ id: "sibling", codeTaskId: "code-1" } as CodeRequest);
    expect((await send(room.id, { action: "abort", requestId: "foreign" })).status).toBe(404);
    expect(state.stopRequest).not.toHaveBeenCalled();
    expect(state.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });

  it("rejects an unknown room, an unsupported action, and a room with nothing running", async () => {
    const room = createRoom({ name: "Team" });
    expect((await send("missing", { action: "abort" })).status).toBe(404);
    expect((await send(room.id, { action: "start" })).status).toBe(400);
    expect((await send(room.id, { action: "abort" })).status).toBe(404);
    expect(state.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });
});

describe("Room Code stop after the cutover", () => {
  it("stops the request in the owning Backend, keeping the lookup local", async () => {
    const room = createRoom({ name: "Room" });
    state.pendingRoom.mockReturnValue({ id: "req-1", botId: "bot-1", state: "running", codeTaskId: "code-1" } as CodeRequest);
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardBotCodeRequestAbort.mockResolvedValue({
      ok: true,
      result: { requestId: "req-1", state: "cancelled", task: { id: "code-1", status: "error" } },
    });

    const response = await send(room.id, { action: "abort" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "code-1", status: "error" } });
    expect(state.forwardBotCodeRequestAbort).toHaveBeenCalledWith("bot-1", "req-1");
    expect(state.stopRequest).not.toHaveBeenCalled();
    expect(state.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });

  it("never stops locally when the Backend cannot take it", async () => {
    const room = createRoom({ name: "Room" });
    state.pendingRoom.mockReturnValue({ id: "req-1", botId: "bot-1", state: "running", codeTaskId: "code-1" } as CodeRequest);
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardBotCodeRequestAbort.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    expect((await send(room.id, { action: "abort" })).status).toBe(409);
    state.forwardBotCodeRequestAbort.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await send(room.id, { action: "abort" });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendを停止できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    expect(state.stopRequest).not.toHaveBeenCalled();
  });
});

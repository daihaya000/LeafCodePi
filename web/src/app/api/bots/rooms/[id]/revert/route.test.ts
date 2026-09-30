import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  cancel: vi.fn<(roomId: string, requestId: string) => number>(() => 0),
  stop: vi.fn(async () => 0),
  clearAttention: vi.fn(),
  forwardRoomRevert: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({
  // Mirrors the real mapper: a coded refusal keeps its status.
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  }),
  clearPendingAttentionForTask: state.clearAttention,
}));
vi.mock("@/lib/pi/bot-code-relay", () => ({ cancelRoomCodeRequests: state.cancel }));
vi.mock("@/lib/room-runtime", () => ({ stopRoomTurns: state.stop }));
vi.mock("@/lib/backend-forward", () => ({ forwardRoomRevert: state.forwardRoomRevert }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: state.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { appendRoomMessage, createRoom, getRoom, setRoomOutcome } from "@/lib/rooms";
import { createBot } from "@/lib/bots";
import { POST } from "./route";

function send(id: string, body: unknown) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-revert-"));
  state.localRuntimeBlocked.mockReturnValue(false);
  state.forwardRoomRevert.mockResolvedValue({
    ok: true,
    result: { text: "やり直したい依頼", images: [], files: [], cancelledCodeRequests: 2 },
  });
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.cancel.mockClear();
  state.stop.mockClear();
  state.clearAttention.mockClear();
  state.forwardRoomRevert.mockClear();
});

describe("room revert", () => {
  it("removes the request and everything after it, returning its text for the composer", async () => {
    const alpha = createBot({ name: "Alpha" });
    const beta = createBot({ name: "Beta" });
    const room = createRoom({ name: "Team", members: [alpha.id, beta.id] });
    const first = appendRoomMessage(room.id, { role: "user", text: "最初の依頼" })!;
    appendRoomMessage(room.id, { role: "assistant", botId: alpha.id, text: "最初の返答", status: "done" });
    const second = appendRoomMessage(room.id, { role: "user", text: "やり直したい依頼" })!;
    appendRoomMessage(room.id, { role: "assistant", botId: alpha.id, text: "途中の返答", status: "working" });
    const third = appendRoomMessage(room.id, { role: "user", text: "さらにやり直したい依頼" })!;
    setRoomOutcome(room.id, { kind: "code-wait", requestId: third.id });
    state.cancel.mockReturnValue(1);

    const result = await send(room.id, { messageId: second.id });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ text: "やり直したい依頼", cancelledCodeRequests: 2 });
    const messages = getRoom(room.id)!.messages;
    expect(messages.map((message) => message.id)).toEqual([first.id, messages[1].id]);
    expect(getRoom(room.id)?.lastOutcome).toBeUndefined();
    // Work started for the removed request has nowhere to report back to.
    expect(state.cancel).toHaveBeenNthCalledWith(1, room.id, second.id);
    expect(state.cancel).toHaveBeenNthCalledWith(2, room.id, third.id);
    // A running conversation would otherwise append new turns into the rewound transcript.
    expect(state.stop).toHaveBeenCalledWith(room.id);
    expect(state.clearAttention).toHaveBeenCalledWith(`bot:${alpha.id}:room:${room.id}`);
    expect(state.clearAttention).toHaveBeenCalledWith(`bot:${beta.id}:room:${room.id}`);
  });

  it("refuses an unknown room, a missing id, and a bot reply", async () => {
    const room = createRoom({ name: "Team" });
    const reply = appendRoomMessage(room.id, { role: "assistant", botId: "a", text: "返答", status: "done" })!;
    expect((await send("missing", { messageId: "x" })).status).toBe(404);
    expect((await send(room.id, {})).status).toBe(400);
    expect((await send(room.id, { messageId: reply.id })).status).toBe(404);
    expect((await send(room.id, { messageId: "unknown" })).status).toBe(404);
    expect(getRoom(room.id)!.messages).toHaveLength(1);
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.clearAttention).not.toHaveBeenCalled();
  });

  it("forwards the rewind after the cutover and touches nothing locally", async () => {
    const room = createRoom({ name: "Team" });
    appendRoomMessage(room.id, { role: "user", text: "やり直したい依頼" });
    state.localRuntimeBlocked.mockReturnValue(true);

    const response = await send(room.id, { messageId: "message-1" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "やり直したい依頼", cancelledCodeRequests: 2 });
    expect(state.forwardRoomRevert).toHaveBeenCalledWith(room.id, "message-1");
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.clearAttention).not.toHaveBeenCalled();
    // The transcript is untouched here: the owner rewound it.
    expect(getRoom(room.id)!.messages).toHaveLength(1);
  });

  it("reports a forwarded failure with its status", async () => {
    const room = createRoom({ name: "Team" });
    appendRoomMessage(room.id, { role: "user", text: "やり直したい依頼" });
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardRoomRevert.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });

    const response = await send(room.id, { messageId: "message-1" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "巻き戻しに失敗しました" });
    state.forwardRoomRevert.mockResolvedValue({ ok: false, reason: "unreachable" });
    expect((await send(room.id, { messageId: "message-1" })).status).toBe(502);
  });
});

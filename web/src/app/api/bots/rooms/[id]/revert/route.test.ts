import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", cancel: vi.fn<(roomId: string, requestId: string) => number>(() => 0) }));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({ jsonError: (error: Error) => ({ error: error.message, status: 500 }) }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ cancelRoomCodeRequests: state.cancel }));

import { appendRoomMessage, createRoom, getRoom, setRoomOutcome } from "@/lib/rooms";
import { POST } from "./route";

function send(id: string, body: unknown) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => { state.root = mkdtempSync(join(tmpdir(), "leafcode-room-revert-")); });
afterEach(() => { rmSync(state.root, { recursive: true, force: true }); state.cancel.mockClear(); });

describe("room revert", () => {
  it("removes the request and everything after it, returning its text for the composer", async () => {
    const room = createRoom({ name: "Team" });
    const first = appendRoomMessage(room.id, { role: "user", text: "最初の依頼" })!;
    appendRoomMessage(room.id, { role: "assistant", botId: "a", text: "最初の返答", status: "done" });
    const second = appendRoomMessage(room.id, { role: "user", text: "やり直したい依頼" })!;
    appendRoomMessage(room.id, { role: "assistant", botId: "a", text: "途中の返答", status: "working" });
    setRoomOutcome(room.id, { kind: "code-wait", requestId: second.id });

    const result = await send(room.id, { messageId: second.id });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ text: "やり直したい依頼" });
    const messages = getRoom(room.id)!.messages;
    expect(messages.map((message) => message.id)).toEqual([first.id, messages[1].id]);
    expect(getRoom(room.id)?.lastOutcome).toBeUndefined();
    // Work started for the removed request has nowhere to report back to.
    expect(state.cancel).toHaveBeenCalledWith(room.id, second.id);
  });

  it("refuses an unknown room, a missing id, a bot reply, and a relayed message", async () => {
    const room = createRoom({ name: "Team" });
    const reply = appendRoomMessage(room.id, { role: "assistant", botId: "a", text: "返答", status: "done" })!;
    const relayed = appendRoomMessage(room.id, { role: "user", text: "Bot経由", sourceBotId: "a" })!;
    expect((await send("missing", { messageId: "x" })).status).toBe(404);
    expect((await send(room.id, {})).status).toBe(400);
    expect((await send(room.id, { messageId: reply.id })).status).toBe(404);
    expect((await send(room.id, { messageId: relayed.id })).status).toBe(404);
    expect(getRoom(room.id)!.messages).toHaveLength(2);
    expect(state.cancel).not.toHaveBeenCalled();
  });
});

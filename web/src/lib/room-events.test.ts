import { describe, expect, it } from "vitest";
import { roomSnapshotSignature } from "./room-events";
import type { RoomAttention, RoomDto } from "./types";

const room: RoomDto = {
  id: "room", name: "Room", members: ["a", "b"],
  createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:01.000Z",
  messages: [{ id: "m1", role: "user", text: "hi", createdAt: 1 }],
};
const waiting: RoomAttention[] = [{ botId: "a", taskId: "bot:a:room:room", permission: { id: "p1" } as RoomAttention["permission"], question: null }];

describe("room snapshot signature", () => {
  it("changes on anything the client renders", () => {
    const base = roomSnapshotSignature(room, []);
    expect(roomSnapshotSignature({ ...room, updatedAt: "2026-09-08T00:00:02.000Z" }, [])).not.toBe(base);
    expect(roomSnapshotSignature({ ...room, messages: [...room.messages, { id: "m2", role: "assistant", text: "yo", createdAt: 2 }] }, [])).not.toBe(base);
    expect(roomSnapshotSignature({ ...room, members: ["a"] }, [])).not.toBe(base);
    expect(roomSnapshotSignature(room, waiting)).not.toBe(base);
  });

  it("catches changes that share one millisecond with the previous write", () => {
    const base = roomSnapshotSignature(room, []);
    const grown = { ...room, messages: [{ ...room.messages[0], text: "hi there" }] };
    const settled = { ...room, messages: [{ ...room.messages[0], status: "done" as const }] };
    const reported = { ...room, messages: [{ ...room.messages[0], codeState: "delivered" as const, codeActivity: "" }] };
    expect(roomSnapshotSignature(grown, [])).not.toBe(base);
    expect(roomSnapshotSignature(settled, [])).not.toBe(base);
    expect(roomSnapshotSignature(reported, [])).not.toBe(base);
    expect(roomSnapshotSignature({ ...room, lastOutcome: { kind: "done", requestId: "m1" } }, [])).not.toBe(base);
  });

  it("stays equal when a task event changed nothing in the room", () => {
    expect(roomSnapshotSignature(room, [])).toBe(roomSnapshotSignature({ ...room, messages: [...room.messages] }, []));
    expect(roomSnapshotSignature(room, waiting)).toBe(roomSnapshotSignature(room, [...waiting]));
  });
});

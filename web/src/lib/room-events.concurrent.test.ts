import { expect, it } from "vitest";
import { roomSnapshotSignature } from "./room-events";
import type { RoomDto } from "./types";

it("detects a sibling Code request changing within the same millisecond", () => {
  const room: RoomDto = {
    id: "room", name: "Room", members: ["bot"], createdAt: "", updatedAt: "",
    messages: [{ id: "response", role: "assistant", text: "two jobs", createdAt: 1, codeRequests: [
      { id: "first", taskId: "code-1", state: "running" },
      { id: "second", taskId: "code-2", state: "running" },
    ] }, { id: "last", role: "user", text: "next", createdAt: 2 }],
  };
  const base = roomSnapshotSignature(room, []);
  room.messages[0].codeRequests![0].state = "delivered";
  expect(roomSnapshotSignature(room, [])).not.toBe(base);
});

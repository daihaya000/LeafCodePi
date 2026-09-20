import { expect, it } from "vitest";
import { roomSnapshotSignature } from "./room-events";
import type { RoomDto } from "./types";

it("detects a sibling Code request changing within the same millisecond", () => {
  const room: RoomDto = {
    id: "room", name: "Room", members: ["bot"], botRelayEnabled: false, createdAt: "", updatedAt: "",
    messages: [{ id: "response", role: "assistant", text: "two jobs", createdAt: 1, codeRequests: [
      { id: "first", taskId: "code-1", state: "running" },
      { id: "second", taskId: "code-2", state: "running" },
    ] }, { id: "last", role: "user", text: "next", createdAt: 2 }],
  };
  const base = roomSnapshotSignature(room, []);
  room.messages[0].codeRequests![0].state = "delivered";
  expect(roomSnapshotSignature(room, [])).not.toBe(base);
});

it("detects per-card Code progress when the Code message is not last", () => {
  const room: RoomDto = {
    id: "room", name: "Room", members: ["bot"], botRelayEnabled: false, createdAt: "", updatedAt: "t1",
    messages: [{
      id: "response", role: "assistant", text: "two jobs", createdAt: 1, codeActivity: "読取",
      codeRequests: [
        { id: "first", taskId: "code-1", state: "running", activity: "読取", todoProgress: { completed: 1, total: 4 } },
        { id: "second", taskId: "code-2", state: "running" },
      ],
    }, { id: "last", role: "user", text: "next", createdAt: 2 }],
  };
  const base = roomSnapshotSignature(room, []);
  room.messages[0].codeRequests![1].activity = "編集";
  room.messages[0].codeRequests![1].todoProgress = { completed: 2, total: 3 };
  room.messages[0].codeActivity = "編集";
  expect(roomSnapshotSignature(room, [])).not.toBe(base);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isCodeRequestId, isRoomCodeRequestCurrent, roomCodeOrigin } from "./bot-code-request.mjs";

test("only the documented task id shape carries a Room origin", () => {
  assert.deepEqual(roomCodeOrigin("bot:one:room:main"), { botId: "one", roomId: "main" });
  assert.deepEqual(roomCodeOrigin("bot:one:room:room:with:colons"), { botId: "one", roomId: "room:with:colons" });
  for (const taskId of ["bot:one", "bot:one:room:", "bot::room:main", "code:bot:one:room:main", "", undefined, null]) {
    assert.equal(roomCodeOrigin(taskId), null, String(taskId));
  }
});

test("a request id is exactly 64 lowercase hex characters", () => {
  assert.equal(isCodeRequestId("a".repeat(64)), true);
  assert.equal(isCodeRequestId("0123456789abcdef".repeat(4)), true);
  for (const value of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `a${"a".repeat(62)}z`, "a".repeat(64) + " ", 42, undefined, null]) {
    assert.equal(isCodeRequestId(value), false, String(value));
  }
});

const stop = (text) => /^\/stop$/i.test(text.trim());

function room(overrides = {}) {
  return {
    id: "room-1",
    members: ["bot-1", "bot-2"],
    messages: [
      { id: "req-1", role: "user", text: "do it" },
      {
        id: "resp-1", role: "assistant", botId: "bot-1", status: "working",
        conversation: { requestId: "req-1", participantIds: ["bot-1"] },
      },
    ],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    botId: "bot-1",
    room: { id: "room-1", responseId: "resp-1", conversation: { requestId: "req-1" } },
    ...overrides,
  };
}

test("a current Room request may deliver", () => {
  assert.equal(isRoomCodeRequestCurrent({ room: room(), request: request(), isRoomStopRequest: stop }), true);
});

test("a request without a Room, or one whose room/response vanished, is not current", () => {
  assert.equal(isRoomCodeRequestCurrent({ room: room(), request: request({ room: undefined }), isRoomStopRequest: stop }), false);
  assert.equal(isRoomCodeRequestCurrent({ room: undefined, request: request(), isRoomStopRequest: stop }), false);
  assert.equal(isRoomCodeRequestCurrent({ room: room({ messages: [] }), request: request(), isRoomStopRequest: stop }), false);
});

test("an error-closed response only stays deliverable after a stop request", () => {
  const errored = room({
    messages: [
      { id: "req-1", role: "user", text: "do it" },
      { id: "resp-1", role: "assistant", botId: "bot-1", status: "error", conversation: { requestId: "req-1", participantIds: ["bot-1"] } },
    ],
  });
  assert.equal(isRoomCodeRequestCurrent({ room: errored, request: request(), isRoomStopRequest: stop }), false);
  const stopped = room({
    messages: [
      { id: "req-1", role: "user", text: "do it" },
      { id: "resp-1", role: "assistant", botId: "bot-1", status: "error", conversation: { requestId: "req-1", participantIds: ["bot-1"] } },
      { id: "stop-1", role: "user", text: "/stop" },
    ],
  });
  assert.equal(isRoomCodeRequestCurrent({ room: stopped, request: request(), isRoomStopRequest: stop }), true);
});

test("a newer work request, a changed conversation or a lost membership ends it", () => {
  const newer = room({
    messages: [
      { id: "req-1", role: "user", text: "do it" },
      { id: "resp-1", role: "assistant", botId: "bot-1", status: "working", conversation: { requestId: "req-1", participantIds: ["bot-1"] } },
      { id: "req-2", role: "user", text: "another" },
    ],
  });
  assert.equal(isRoomCodeRequestCurrent({ room: newer, request: request(), isRoomStopRequest: stop }), false);
  const drifted = room({
    messages: [
      { id: "req-1", role: "user", text: "do it" },
      { id: "resp-1", role: "assistant", botId: "bot-1", status: "working", conversation: { requestId: "other", participantIds: ["bot-1"] } },
    ],
  });
  assert.equal(isRoomCodeRequestCurrent({ room: drifted, request: request(), isRoomStopRequest: stop }), false);
  const notParticipant = room({
    messages: [
      { id: "req-1", role: "user", text: "do it" },
      { id: "resp-1", role: "assistant", botId: "bot-1", status: "working", conversation: { requestId: "req-1", participantIds: ["bot-2"] } },
    ],
  });
  assert.equal(isRoomCodeRequestCurrent({ room: notParticipant, request: request(), isRoomStopRequest: stop }), false);
  assert.equal(isRoomCodeRequestCurrent({ room: room({ members: ["bot-2"] }), request: request(), isRoomStopRequest: stop }), false);
});

test("a stop line before the request does not count as a stop after it", () => {
  const before = room({
    messages: [
      { id: "stop-0", role: "user", text: "/stop" },
      { id: "req-1", role: "user", text: "do it" },
      { id: "resp-1", role: "assistant", botId: "bot-1", status: "error", conversation: { requestId: "req-1", participantIds: ["bot-1"] } },
    ],
  });
  assert.equal(isRoomCodeRequestCurrent({ room: before, request: request(), isRoomStopRequest: stop }), false);
});

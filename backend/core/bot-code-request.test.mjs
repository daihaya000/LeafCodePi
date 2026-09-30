import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancellationTargetForRequest, isActiveCodeRequest, isCodeRequestId, isRoomCodeRequestCurrent,
  resolveOutboxScanAction, roomCodeOrigin, runningCodeTaskIdsForOrigin, selectActiveCodeRequestForTask,
} from "./bot-code-request.mjs";

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

test("only delivered and cancelled requests stop being active", () => {
  for (const state of ["queued", "starting", "running", "ready"]) {
    assert.equal(isActiveCodeRequest({ state }), true, state);
  }
  for (const state of ["delivered", "cancelled"]) {
    assert.equal(isActiveCodeRequest({ state }), false, state);
  }
  assert.equal(isActiveCodeRequest(undefined), true, "a missing state is not terminal");
});

const req = (overrides) => ({ id: "a".repeat(64), botId: "bot-1", originTaskId: "bot:bot-1", codeTaskId: "code-1", state: "running", ...overrides });

test("the newest active non-intervention request owns the Code task", () => {
  const older = req({ id: "b".repeat(64), queuedAt: 100 });
  const newer = req({ id: "c".repeat(64), queuedAt: 200 });
  assert.equal(selectActiveCodeRequestForTask([older, newer], "code-1"), newer);
  assert.equal(selectActiveCodeRequestForTask([newer, older], "code-1"), newer);
  // Same queue time: the larger id wins, so every reader agrees.
  const same = req({ id: "d".repeat(64), queuedAt: 200 });
  assert.equal(selectActiveCodeRequestForTask([newer, same], "code-1"), same);
});

test("a delivered, cancelled, intervention or other-task request never owns it", () => {
  const delivered = req({ id: "e".repeat(64), state: "delivered", queuedAt: 300 });
  const cancelled = req({ id: "f".repeat(64), state: "cancelled", queuedAt: 300 });
  const intervention = req({ id: "g".repeat(64), userIntervention: true, queuedAt: 300 });
  const other = req({ id: "h".repeat(64), codeTaskId: "code-2", queuedAt: 300 });
  const active = req({ id: "i".repeat(64), queuedAt: 100 });
  assert.equal(selectActiveCodeRequestForTask([delivered, cancelled, intervention, other, active], "code-1"), active);
  assert.equal(selectActiveCodeRequestForTask([delivered, cancelled], "code-1"), undefined);
  assert.equal(selectActiveCodeRequestForTask([], "code-1"), undefined);
});

test("running Code tasks for an origin are launch requests in read order", () => {
  const requests = [
    req({ id: "a".repeat(64), codeTaskId: "code-1", state: "running" }),
    req({ id: "b".repeat(64), codeTaskId: "code-2", state: "starting" }),
    req({ id: "c".repeat(64), codeTaskId: "code-3", state: "queued" }),
    req({ id: "d".repeat(64), codeTaskId: "code-4", state: "ready" }),
    req({ id: "e".repeat(64), codeTaskId: "code-5", state: "delivered" }),
    req({ id: "f".repeat(64), codeTaskId: "code-6", state: "running", userIntervention: true }),
    req({ id: "g".repeat(64), codeTaskId: null, state: "running" }),
    req({ id: "h".repeat(64), originTaskId: "bot:other", codeTaskId: "code-7", state: "running" }),
  ];
  assert.deepEqual(runningCodeTaskIdsForOrigin(requests, "bot:bot-1"), ["code-1", "code-2"]);
  assert.deepEqual(runningCodeTaskIdsForOrigin(requests, "bot:other"), ["code-7"]);
  assert.deepEqual(runningCodeTaskIdsForOrigin([], "bot:bot-1"), []);
});

test("an outbox scan starts queued rows and re-queues only a crash-left starting row", () => {
  assert.equal(resolveOutboxScanAction({ state: "queued", isBusy: false }), "start");
  assert.equal(resolveOutboxScanAction({ state: "queued", isBusy: true }), "start", "a queued row starts even while another prompt runs");
  assert.equal(resolveOutboxScanAction({ state: "starting", isBusy: true }), "wait");
  assert.equal(resolveOutboxScanAction({ state: "starting", isBusy: false }), "requeue");
  for (const state of ["running", "ready", "delivered", "cancelled"]) {
    assert.equal(resolveOutboxScanAction({ state, isBusy: false }), "wait", state);
  }
});

test("cancelling a request only aborts a Code task that was actually started", () => {
  assert.equal(cancellationTargetForRequest({ state: "queued", codeTaskId: "code-1" }), null);
  assert.equal(cancellationTargetForRequest({ state: "starting", codeTaskId: "code-1" }), "code-1");
  assert.equal(cancellationTargetForRequest({ state: "running", codeTaskId: "code-1" }), "code-1");
  assert.equal(cancellationTargetForRequest({ state: "ready", codeTaskId: null }), null);
  assert.equal(cancellationTargetForRequest(undefined), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCodeRequestRecord, cancellationTargetForRequest, codeAutoChainRefusal, codeCompletionAction,
  codeGoalLoopRefusal,
  codeLaunchRefusal, codeLinkedSessionState, codePromptRefusal, codeProjectRefusal, codeReportingRefusal,
  codeTaskIdRefusal, CODE_DELIVERY_RETRY_MS, CODE_RELAY_TICK_MS,
  MAX_AUTO_CODE_CHAIN, MAX_CODE_PROMPT_CHARS,
  CODE_REQUEST_RETENTION_MS, codeRequestPayload,
  codeResultBaselineMessages,
  codeResultLatestAssistant, codeResultOutcome, codeResultOutput, codeSessionChangedPayload, isActiveCodeRequest,
  isCodeRequestId, isRoomCodeRequestCurrent,
  resolveOutboxScanAction, roomCodeOrigin, runningCodeTaskIdsForOrigin, selectActiveCodeRequestForTask,
  parseGoalLoopInput, shouldAttemptCodeDelivery, shouldConfirmCodeDelivery, shouldPruneCodeRequest,
  shouldStartCodeRelayTick, truncateCodeReportRequest, userStoppedResult,
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

test("a delivered result exposes its outcome and Goal Loop report", () => {
  assert.deepEqual(codeRequestPayload({ result: '{"outcome":"completed","goalLoop":{"status":"done","turnCount":2}}' }), {
    outcome: "completed",
    goalLoop: { status: "done", turnCount: 2 },
  });
  assert.deepEqual(codeRequestPayload({ result: '{"outcome":"","goalLoop":{"turnCount":2}}' }), {}, "an empty outcome is dropped");
  assert.deepEqual(codeRequestPayload({ result: '{"goalLoop":{"status":42}}' }), {}, "a Goal Loop without a status is dropped");
  assert.deepEqual(codeRequestPayload({ result: '{"outcome":42}' }), {});
  assert.deepEqual(codeRequestPayload({ result: "" }), {});
  assert.deepEqual(codeRequestPayload({}), {});
  assert.deepEqual(codeRequestPayload(undefined), {});
});

test("an unparsable result is treated as a legacy plain-string outcome", () => {
  assert.deepEqual(codeRequestPayload({ result: "boom" }), { outcome: "boom" });
  assert.deepEqual(codeRequestPayload({ result: "  boom  " }), { outcome: "boom" });
  assert.deepEqual(codeRequestPayload({ result: "   " }), {});
  // Valid JSON that is not an object parses fine and simply has no outcome to expose.
  assert.deepEqual(codeRequestPayload({ result: "[1,2]" }), {});
  assert.deepEqual(codeRequestPayload({ result: "42" }), {});
});

test("a user stop keeps the produced fields and replaces the outcome", () => {
  assert.equal(userStoppedResult('{"outcome":"completed","detail":"x"}'), '{"outcome":"ユーザーが停止","detail":"x"}');
  assert.equal(userStoppedResult("{}"), '{"outcome":"ユーザーが停止"}');
  assert.equal(userStoppedResult("not json"), '{"outcome":"ユーザーが停止"}');
  assert.equal(userStoppedResult("[1,2]"), '{"outcome":"ユーザーが停止"}');
  assert.equal(userStoppedResult(null), '{"outcome":"ユーザーが停止"}');
  assert.equal(userStoppedResult(undefined), '{"outcome":"ユーザーが停止"}');
});

test("a state-change event carries the request, its Code task and the state", () => {
  assert.deepEqual(
    codeSessionChangedPayload({ eventType: "bot-code-session-changed", requestId: "r1", codeTaskId: "code-1", state: "running" }),
    { type: "snapshot", eventType: "bot-code-session-changed", codeRequestId: "r1", codeTaskId: "code-1", codeState: "running" },
  );
  assert.deepEqual(
    codeSessionChangedPayload({ eventType: "e", requestId: "r1", codeTaskId: null, state: "queued" }).codeTaskId,
    null,
    "a request without a Code task keeps the null id",
  );
});

test("a completion captures a running request and only rewrites outcomes for a user stop", () => {
  assert.equal(codeCompletionAction({ state: "running", stoppedByUser: false }), "capture");
  assert.equal(codeCompletionAction({ state: "running", stoppedByUser: true }), "capture", "a stop while running still captures the produced result");
  assert.equal(codeCompletionAction({ state: "starting", stoppedByUser: true }), "stop-and-ready");
  assert.equal(codeCompletionAction({ state: "starting", stoppedByUser: false }), "none");
  assert.equal(codeCompletionAction({ state: "ready", stoppedByUser: true }), "stop-only");
  assert.equal(codeCompletionAction({ state: "ready", stoppedByUser: false }), "none");
  for (const state of ["queued", "delivered", "cancelled", "", "unknown"]) {
    assert.equal(codeCompletionAction({ state, stoppedByUser: true }), "none", state);
  }
});

test("only an explicit true counts as a user stop", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(codeCompletionAction({ state: "starting", stoppedByUser: value }), "none", String(value));
    assert.equal(codeCompletionAction({ state: "ready", stoppedByUser: value }), "none", String(value));
    assert.equal(codeCompletionAction({ state: "running", stoppedByUser: value }), "capture", String(value));
  }
});

test("a run reports only what happened after its baseline", () => {
  const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
  assert.deepEqual(codeResultBaselineMessages(messages, "m1"), [{ id: "m2" }, { id: "m3" }]);
  assert.deepEqual(codeResultBaselineMessages(messages, "m3"), []);
  assert.deepEqual(codeResultBaselineMessages(messages, null), messages, "no baseline means the whole transcript");
  assert.deepEqual(codeResultBaselineMessages(messages, "gone"), [], "a vanished baseline breaks the correlation");
  assert.deepEqual(codeResultBaselineMessages(undefined, "m1"), []);
});

test("the latest assistant message carries the report text", () => {
  const messages = [{ id: "u1", role: "user" }, { id: "a1", role: "assistant" }, { id: "a2", role: "assistant" }];
  assert.deepEqual(codeResultLatestAssistant(messages), { id: "a2", role: "assistant" });
  assert.equal(codeResultLatestAssistant([{ id: "u1", role: "user" }]), undefined);
  assert.equal(codeResultLatestAssistant([]), undefined);
  assert.equal(codeResultLatestAssistant(undefined), undefined);
});

test("the outcome word follows the documented precedence", () => {
  const base = {
    hasTask: true, stoppedByUser: false, manualAborted: false, archived: false,
    taskError: null, messageError: null, goalLoopOutcome: null, hasText: true,
  };
  assert.equal(codeResultOutcome(base), "実行終了");
  assert.equal(codeResultOutcome({ ...base, hasTask: false }), "セッションが削除されました");
  assert.equal(codeResultOutcome({ ...base, stoppedByUser: true }), "ユーザーが停止");
  assert.equal(codeResultOutcome({ ...base, manualAborted: true }), "停止・中断");
  assert.equal(codeResultOutcome({ ...base, archived: true }), "停止・中断");
  assert.equal(codeResultOutcome({ ...base, taskError: "boom" }), "失敗");
  assert.equal(codeResultOutcome({ ...base, messageError: "boom" }), "失敗");
  assert.equal(codeResultOutcome({ ...base, goalLoopOutcome: "目標達成" }), "目標達成");
  assert.equal(codeResultOutcome({ ...base, hasText: false }), "結果を取得できませんでした");
  // The earlier reasons win over the later ones.
  assert.equal(codeResultOutcome({ ...base, stoppedByUser: true, manualAborted: true, taskError: "boom", goalLoopOutcome: "目標達成" }), "ユーザーが停止");
  assert.equal(codeResultOutcome({ ...base, taskError: "boom", goalLoopOutcome: "目標達成" }), "失敗");
  assert.equal(codeResultOutcome({ ...base, goalLoopOutcome: "目標達成", hasText: false }), "目標達成");
});

test("only an explicit flag selects an earlier outcome reason", () => {
  const base = {
    hasTask: true, stoppedByUser: false, manualAborted: false, archived: false,
    taskError: null, messageError: null, goalLoopOutcome: null, hasText: true,
  };
  for (const value of [undefined, null, 0, "true", 1]) {
    // A missing task is the deleted-session outcome, exactly like the original `!task` check.
    assert.equal(codeResultOutcome({ ...base, hasTask: value }), "セッションが削除されました", String(value));
    assert.equal(codeResultOutcome({ ...base, stoppedByUser: value }), "実行終了", String(value));
    assert.equal(codeResultOutcome({ ...base, manualAborted: value }), "実行終了", String(value));
    assert.equal(codeResultOutcome({ ...base, archived: value }), "実行終了", String(value));
    assert.equal(codeResultOutcome({ ...base, hasText: value }), "結果を取得できませんでした", String(value));
  }
});

test("the report output is cut at the limit and says so", () => {
  assert.deepEqual(codeResultOutput("abc", 5), { output: "abc", truncated: false });
  assert.deepEqual(codeResultOutput("abcdef", 5), { output: "abcde", truncated: true });
  assert.deepEqual(codeResultOutput("abcde", 5), { output: "abcde", truncated: false });
  assert.deepEqual(codeResultOutput("", 5), { output: "", truncated: false });
  assert.deepEqual(codeResultOutput(undefined, 5), { output: "", truncated: false });
});

test("a busy origin or an unexpired backoff defers the delivery", () => {
  const now = 1_000_000;
  assert.equal(shouldAttemptCodeDelivery({ originBusy: false, nextAttemptAt: undefined, now }), true);
  assert.equal(shouldAttemptCodeDelivery({ originBusy: false, nextAttemptAt: now - 1, now }), true);
  // The original compares with `>`, so a backoff ending exactly now is already expired.
  assert.equal(shouldAttemptCodeDelivery({ originBusy: false, nextAttemptAt: now, now }), true);
  assert.equal(shouldAttemptCodeDelivery({ originBusy: false, nextAttemptAt: now + CODE_DELIVERY_RETRY_MS, now }), false);
  assert.equal(shouldAttemptCodeDelivery({ originBusy: true, nextAttemptAt: undefined, now }), false, "the origin is mid-turn");
  assert.equal(shouldAttemptCodeDelivery({ originBusy: true, nextAttemptAt: now - 1, now }), false);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(shouldAttemptCodeDelivery({ originBusy: value, nextAttemptAt: undefined, now }), true, String(value));
  }
  assert.equal(CODE_DELIVERY_RETRY_MS, 30_000);
});

test("a delivery is not written over an already delivered or cancelled request", () => {
  assert.equal(shouldConfirmCodeDelivery({ state: "ready" }), true);
  assert.equal(shouldConfirmCodeDelivery({ state: "running" }), true, "any other state may be flipped to delivered");
  assert.equal(shouldConfirmCodeDelivery({ state: "delivered" }), false);
  assert.equal(shouldConfirmCodeDelivery({ state: "cancelled" }), false, "an in-flight stop wins over a stale success");
});

test("only a settled request older than the retention window is pruned", () => {
  const now = 1_000_000_000;
  assert.equal(CODE_REQUEST_RETENTION_MS, 7 * 86_400_000);
  assert.equal(shouldPruneCodeRequest({ isActive: false, fileMtimeMs: now - CODE_REQUEST_RETENTION_MS - 1, now }), true);
  assert.equal(shouldPruneCodeRequest({ isActive: false, fileMtimeMs: now - CODE_REQUEST_RETENTION_MS, now }), false, "the boundary keeps the file");
  assert.equal(shouldPruneCodeRequest({ isActive: false, fileMtimeMs: now, now }), false);
  assert.equal(shouldPruneCodeRequest({ isActive: true, fileMtimeMs: now - CODE_REQUEST_RETENTION_MS - 1, now }), false, "an active request is never pruned");
  assert.equal(shouldPruneCodeRequest({ isActive: false, fileMtimeMs: undefined, now }), false, "a stat failure must not delete the file");
});

test("one scan runs at a time and the interval is two seconds", () => {
  assert.equal(CODE_RELAY_TICK_MS, 2_000);
  assert.equal(shouldStartCodeRelayTick({ ticking: false }), true);
  assert.equal(shouldStartCodeRelayTick({ ticking: true }), false);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(shouldStartCodeRelayTick({ ticking: value }), true, String(value));
  }
});

test("a long request is cut to the limit without splitting a surrogate pair", () => {
  assert.equal(truncateCodeReportRequest("abc", 5), "abc");
  assert.equal(truncateCodeReportRequest("abcde", 5), "abcde");
  assert.equal(truncateCodeReportRequest("abcdef", 5), "abcd…", "the ellipsis counts toward the limit");
  const emoji = "😀".repeat(4);
  const cut = truncateCodeReportRequest(emoji, 3);
  assert.equal(Array.from(cut).length, 3);
  assert.equal(cut, "😀😀…");
  assert.equal(truncateCodeReportRequest("", 5), "");
  assert.equal(truncateCodeReportRequest(undefined, 5), "");
});

const goalLoopDeps = {
  normalizeAcceptance: (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : null),
  clampMaxTurns: (value, fallback) => (typeof value === "number" ? Math.max(0, Math.min(100, value)) : fallback),
  clampCooldownSeconds: (value) => (typeof value === "number" ? Math.max(0, value) : 0),
  defaultMaxTurns: 10,
};

test("Goal Loop options are validated, normalized and clamped", () => {
  assert.equal(parseGoalLoopInput(undefined, goalLoopDeps), undefined, "no loop means nothing to parse");
  assert.deepEqual(parseGoalLoopInput({}, goalLoopDeps), {
    acceptance: [], maxTurns: 10, cooldownSeconds: 0, forceFullRun: false,
  });
  assert.deepEqual(parseGoalLoopInput({ acceptance: ["a"], maxTurns: 500, cooldownSeconds: 60, forceFullRun: true }, goalLoopDeps), {
    acceptance: ["a"], maxTurns: 100, cooldownSeconds: 60, forceFullRun: true,
  });
});

test("a malformed Goal Loop option is rejected with its own message", () => {
  for (const value of [null, [], "x", 42, true]) {
    assert.throws(() => parseGoalLoopInput(value, goalLoopDeps), /goalLoop must be an object/, String(value));
  }
  for (const bad of [{ maxTurns: "5" }, { cooldownSeconds: "60" }, { forceFullRun: "yes" }]) {
    assert.throws(() => parseGoalLoopInput(bad, goalLoopDeps), /invalid goalLoop/, JSON.stringify(bad));
  }
  assert.throws(() => parseGoalLoopInput({ acceptance: "not a list" }, goalLoopDeps), /invalid goalLoop acceptance/);
  // Only an explicit true enables the full-run override; a non-boolean value is rejected above.
  for (const value of [undefined, false]) {
    assert.equal(parseGoalLoopInput({ forceFullRun: value }, goalLoopDeps).forceFullRun, false, String(value));
  }
  for (const value of [null, 0, "true", 1]) {
    assert.throws(() => parseGoalLoopInput({ forceFullRun: value }, goalLoopDeps), /invalid goalLoop/, String(value));
  }
});

test("taskId is refused for a start and for an unusable value", () => {
  assert.equal(codeTaskIdRefusal({ action: "prompt", taskId: undefined }), null);
  assert.equal(codeTaskIdRefusal({ action: "status", taskId: "task-1" }), null);
  assert.equal(codeTaskIdRefusal({ action: "start", taskId: "task-1" }), "taskId is only supported for an existing Code session");
  for (const taskId of ["", "   ", 42, null, {}]) {
    assert.equal(codeTaskIdRefusal({ action: "prompt", taskId }), "taskId is only supported for an existing Code session", String(taskId));
  }
});

test("goalLoop is refused unless the action starts Code", () => {
  assert.equal(codeGoalLoopRefusal({ action: "start", hasGoalLoop: true }), null);
  assert.equal(codeGoalLoopRefusal({ action: "prompt", hasGoalLoop: true }), "goalLoop is only supported when starting Code");
  assert.equal(codeGoalLoopRefusal({ action: "prompt", hasGoalLoop: false }), null);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(codeGoalLoopRefusal({ action: "prompt", hasGoalLoop: value }), null, String(value));
  }
});

test("the reporting gates refuse a stop, a Room report and a second follow-up", () => {
  assert.equal(codeReportingRefusal({ report: null, action: "start" }), null);
  assert.equal(codeReportingRefusal({ report: { room: false, followUpStarted: false }, action: "start" }), null);
  assert.match(codeReportingRefusal({ report: { userStopped: true }, action: "start" }), /user stopped/);
  assert.match(codeReportingRefusal({ report: { room: true }, action: "start" }), /Result reporting cannot/);
  assert.match(codeReportingRefusal({ report: { followUpStarted: true }, action: "start" }), /Only one follow-up/);
  assert.match(codeReportingRefusal({ report: { room: false }, action: "abort" }), /Only one follow-up/, "an abort consumes the slot");
  // The stop gate wins over the others.
  assert.match(codeReportingRefusal({ report: { userStopped: true, room: true, followUpStarted: true }, action: "abort" }), /user stopped/);
});

test("the autonomous continuation limit reports the configured maximum", () => {
  assert.equal(codeAutoChainRefusal({ autoChain: 5, maxChain: 5 }), null);
  assert.match(codeAutoChainRefusal({ autoChain: 6, maxChain: 5 }), /cumulative limit of 5/);
  assert.equal(codeAutoChainRefusal({ autoChain: 0, maxChain: 5 }), null);
});

test("a prompt is required within the limit, except for an abort", () => {
  assert.equal(codePromptRefusal({ action: "start", prompt: "do it" }), null);
  assert.equal(codePromptRefusal({ action: "abort", prompt: undefined }), null);
  assert.equal(codePromptRefusal({ action: "start", prompt: "   " }), "A prompt of 1–32000 characters is required");
  assert.equal(codePromptRefusal({ action: "start", prompt: undefined }), "A prompt of 1–32000 characters is required");
  assert.equal(codePromptRefusal({ action: "start", prompt: "a".repeat(MAX_CODE_PROMPT_CHARS) }), null);
  assert.equal(codePromptRefusal({ action: "start", prompt: "a".repeat(MAX_CODE_PROMPT_CHARS + 1) }), "A prompt of 1–32000 characters is required");
  assert.equal(MAX_CODE_PROMPT_CHARS, 32_000);
  assert.equal(MAX_AUTO_CODE_CHAIN, 5);
});

test("the linked session state reports the first unusable reason", () => {
  assert.equal(codeLinkedSessionState({ hasSession: true, archived: false, permissionDenied: false, busy: false }), "available");
  assert.equal(codeLinkedSessionState({ hasSession: false, archived: false, permissionDenied: false, busy: false }), "missing");
  assert.equal(codeLinkedSessionState({ hasSession: true, archived: true, permissionDenied: false, busy: false }), "archived");
  assert.equal(codeLinkedSessionState({ hasSession: true, archived: false, permissionDenied: true, busy: false }), "denied");
  assert.equal(codeLinkedSessionState({ hasSession: true, archived: false, permissionDenied: false, busy: true }), "busy");
  assert.equal(codeLinkedSessionState({ hasSession: true, archived: true, permissionDenied: true, busy: true }), "archived", "the first reason wins");
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(codeLinkedSessionState({ hasSession: value, archived: false, permissionDenied: false, busy: false }), "missing", String(value));
    assert.equal(codeLinkedSessionState({ hasSession: true, archived: value, permissionDenied: false, busy: false }), "available", String(value));
  }
});

test("the pre-launch refusals follow the documented order", () => {
  const base = { botPermissionMode: "ask", isRoomRequest: false, roomRequestCurrent: true, action: "start", linkedState: "available" };
  assert.equal(codeLaunchRefusal(base), null);
  assert.match(codeLaunchRefusal({ ...base, botPermissionMode: "deny" }), /does not permit/);
  assert.match(codeLaunchRefusal({ ...base, isRoomRequest: true, roomRequestCurrent: false }), /no longer active/);
  assert.equal(codeLaunchRefusal({ ...base, isRoomRequest: true, roomRequestCurrent: true }), null);
  assert.match(codeLaunchRefusal({ ...base, action: "status" }), /Unknown Code action/);
  assert.match(codeLaunchRefusal({ ...base, action: "prompt", linkedState: "busy" }), /unavailable or busy/);
  assert.equal(codeLaunchRefusal({ ...base, action: "prompt", linkedState: "available" }), null);
  // The earlier refusals win over the later ones.
  assert.match(codeLaunchRefusal({ ...base, botPermissionMode: "deny", isRoomRequest: true, roomRequestCurrent: false, action: "status" }), /does not permit/);
  assert.match(codeLaunchRefusal({ ...base, isRoomRequest: true, roomRequestCurrent: false, action: "status" }), /no longer active/);
  assert.match(codeLaunchRefusal({ ...base, action: "status", linkedState: "missing" }), /Unknown Code action/, "an unknown action is refused before the session state is read");
});

test("a project is only refused when one was requested but is unusable", () => {
  assert.equal(codeProjectRefusal({ hasProjectId: false, hasProject: false, archived: false }), null);
  assert.equal(codeProjectRefusal({ hasProjectId: true, hasProject: true, archived: false }), null);
  assert.equal(codeProjectRefusal({ hasProjectId: true, hasProject: false, archived: false }), "Project is unavailable");
  assert.equal(codeProjectRefusal({ hasProjectId: true, hasProject: true, archived: true }), "Project is unavailable");
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(codeProjectRefusal({ hasProjectId: value, hasProject: false, archived: false }), null, String(value));
    assert.equal(codeProjectRefusal({ hasProjectId: true, hasProject: value, archived: false }), "Project is unavailable", String(value));
  }
});

test("a start records no linked session or baseline, a prompt records both", () => {
  const base = {
    id: "r1", botId: "bot-1", originTaskId: "bot:bot-1", projectId: null,
    queuedAt: 1_000, prompt: "  do it  ", linkedTaskId: "code-1", baseline: "msg-1",
  };
  assert.deepEqual(buildCodeRequestRecord({ ...base, action: "start" }), {
    id: "r1", botId: "bot-1", originTaskId: "bot:bot-1", codeTaskId: null,
    state: "starting", action: "start", projectId: null, queuedAt: 1_000, prompt: "do it", baseline: null,
  });
  assert.deepEqual(buildCodeRequestRecord({ ...base, action: "prompt" }), {
    id: "r1", botId: "bot-1", originTaskId: "bot:bot-1", codeTaskId: "code-1",
    state: "starting", action: "prompt", projectId: null, queuedAt: 1_000, prompt: "do it", baseline: "msg-1",
  });
});

test("optional parts are omitted instead of stored empty", () => {
  const base = {
    id: "r1", botId: "bot-1", originTaskId: "bot:bot-1", action: "start",
    projectId: null, queuedAt: 1_000, prompt: "do it",
  };
  const bare = buildCodeRequestRecord(base);
  for (const key of ["goalLoop", "autoChain", "room", "promptOptions"]) {
    assert.equal(key in bare, false, key);
  }
  const full = buildCodeRequestRecord({
    ...base,
    goalLoop: { maxTurns: 3 },
    autoChain: 2,
    room: { id: "room-1" },
    images: [{ mimeType: "image/png", data: "x" }],
  });
  assert.deepEqual(full.goalLoop, { maxTurns: 3 });
  assert.equal(full.autoChain, 2);
  assert.deepEqual(full.room, { id: "room-1" });
  assert.deepEqual(full.promptOptions, { images: [{ mimeType: "image/png", data: "x" }] });
  // A zero count and an empty image list are "absent".
  assert.equal("autoChain" in buildCodeRequestRecord({ ...base, autoChain: 0 }), false);
  assert.equal("promptOptions" in buildCodeRequestRecord({ ...base, images: [] }), false);
  assert.equal("promptOptions" in buildCodeRequestRecord({ ...base, images: undefined }), false);
});

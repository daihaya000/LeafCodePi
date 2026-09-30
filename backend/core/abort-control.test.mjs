import assert from "node:assert/strict";
import { test } from "node:test";
import { finalAssistantIdOfCurrentTurn, isHangWatchReplaced, roomBotIdFromTaskId } from "./abort-control.mjs";

test("final assistant id belongs to the newest user turn only", () => {
  assert.equal(finalAssistantIdOfCurrentTurn([]), "");
  assert.equal(finalAssistantIdOfCurrentTurn([{ role: "assistant", id: "orphan" }]), "");
  assert.equal(finalAssistantIdOfCurrentTurn([{ role: "user", id: "u1" }]), "");
  assert.equal(finalAssistantIdOfCurrentTurn([
    { role: "user", id: "u1" }, { role: "assistant", id: "a1" },
    { role: "user", id: "u2" },
  ]), "");
  assert.equal(finalAssistantIdOfCurrentTurn([
    { role: "user", id: "u1" }, { role: "assistant", id: "a1" },
    { role: "user", id: "u2" }, { role: "assistant", id: "a2" }, { role: "tool", id: "t" }, { role: "assistant", id: "a3" },
  ]), "a3");
  assert.equal(finalAssistantIdOfCurrentTurn([{ role: "user" }, { role: "assistant" }]), "");
});

test("Room task ids identify only bot room sessions", () => {
  assert.equal(roomBotIdFromTaskId("bot:one:room:main"), "one");
  assert.equal(roomBotIdFromTaskId("bot:one:room:"), "one");
  assert.equal(roomBotIdFromTaskId("bot:one"), null);
  assert.equal(roomBotIdFromTaskId("code:bot:one:room:x"), null);
  assert.equal(roomBotIdFromTaskId("bot::room:x"), null);
});

test("a replaced hang watch is recognised only when both watches exist and differ", () => {
  assert.equal(isHangWatchReplaced(1, { startedAt: 2 }), true);
  assert.equal(isHangWatchReplaced(1, { startedAt: 1 }), false);
  assert.equal(isHangWatchReplaced(undefined, { startedAt: 2 }), false);
  assert.equal(isHangWatchReplaced(null, { startedAt: 2 }), false);
  assert.equal(isHangWatchReplaced(1, undefined), false);
  assert.equal(isHangWatchReplaced(0, { startedAt: 5 }), true);
});

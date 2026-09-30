import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOutcome, normalizeRoom, ROOM_OUTCOME_KINDS } from "./room-normalize.mjs";

const STATES = ["waiting", "ready", "running", "done", "failed", "cancelled"];
const ID = "0f0f0f0f-aaaa-bbbb-cccc-0123456789ab";
const message = (overrides = {}) => ({ id: "m1", role: "user", text: "hi", createdAt: 1, ...overrides });
const handoff = (overrides = {}) => ({
  id: "h1", requestId: "r1", fromMessageId: "m1", fromBotId: "a", toBotId: "b", task: "do", state: "waiting", createdAt: 2, ...overrides,
});
const room = (overrides = {}) => ({ id: ID, name: "Room", members: ["a", "b"], createdAt: "c", updatedAt: "u", ...overrides });

test("outcomes accept only the known kinds with a string request id", () => {
  for (const kind of ROOM_OUTCOME_KINDS) assert.deepEqual(normalizeOutcome({ kind, requestId: "r", extra: 1 }), { kind, requestId: "r" });
  assert.equal(normalizeOutcome({ kind: "unknown", requestId: "r" }), undefined);
  assert.equal(normalizeOutcome({ kind: "done", requestId: 5 }), undefined);
  assert.equal(normalizeOutcome({ kind: 1, requestId: "r" }), undefined);
  assert.equal(normalizeOutcome(undefined), undefined);
  assert.equal(normalizeOutcome(null), undefined);
});

test("records that are not a room with this id are rejected", () => {
  assert.equal(normalizeRoom(room({ id: "other" }), ID, STATES), null);
  assert.equal(normalizeRoom(room({ name: 1 }), ID, STATES), null);
  assert.equal(normalizeRoom(room({ members: "a" }), ID, STATES), null);
  const { id: _omit, ...withoutId } = room();
  assert.equal(normalizeRoom(withoutId, ID, STATES), null);
});

test("a minimal room gets safe defaults and stringified timestamps", () => {
  assert.deepEqual(normalizeRoom(room({ createdAt: 12, updatedAt: undefined }), ID, STATES), {
    id: ID, name: "Room", members: ["a", "b"], botRelayEnabled: false, createdAt: "12", updatedAt: "undefined", messages: [],
  });
});

test("members are de-duplicated and non-strings dropped, keeping first-seen order", () => {
  assert.deepEqual(normalizeRoom(room({ members: ["b", "a", "b", 7, null, "a"] }), ID, STATES).members, ["b", "a"]);
});

test("relay and Code auto-approve are opt-in and only true enables them", () => {
  assert.equal(normalizeRoom(room({ botRelayEnabled: "true" }), ID, STATES).botRelayEnabled, false);
  assert.equal(normalizeRoom(room({ botRelayEnabled: true }), ID, STATES).botRelayEnabled, true);
  assert.equal("codeAutoApprove" in normalizeRoom(room({ codeAutoApprove: 1 }), ID, STATES), false);
  assert.equal(normalizeRoom(room({ codeAutoApprove: true }), ID, STATES).codeAutoApprove, true);
});

test("malformed messages are dropped and file attachments must be fully described", () => {
  const good = message({ id: "good", files: [{ file: "f", name: "n", mimeType: "text/plain", size: 3 }] });
  const result = normalizeRoom(room({ messages: [
    good, message({ id: "assistant", role: "assistant" }), message({ id: "", text: "empty id is still a string" }),
    message({ role: "system" }), message({ text: 1 }), message({ createdAt: "1" }), null, "x",
    message({ id: "bad-files", files: "nope" }), message({ id: "bad-file", files: [{ file: "f", name: "n", mimeType: "t" }] }),
    message({ id: "null-file", files: [null] }),
  ] }), ID, STATES);
  assert.deepEqual(result.messages.map((m) => m.id), ["good", "assistant", ""]);
  assert.equal(normalizeRoom(room({ messages: "nope" }), ID, STATES).messages.length, 0);
});

test("handoffs keep only complete records in a known state, and the field is omitted when none remain", () => {
  const kept = normalizeRoom(room({ handoffs: [handoff(), handoff({ id: "h2", state: "done" }), handoff({ id: "x", state: "exploded" }), handoff({ id: "y", task: 1 }), handoff({ id: "z", createdAt: "2" }), null] }), ID, STATES);
  assert.deepEqual(kept.handoffs.map((h) => h.id), ["h1", "h2"]);
  assert.equal("handoffs" in normalizeRoom(room({ handoffs: [handoff({ state: "exploded" })] }), ID, STATES), false);
  assert.equal("handoffs" in normalizeRoom(room({ handoffs: "nope" }), ID, STATES), false);
});

test("the handoff vocabulary is injected, so a narrower set changes what is kept", () => {
  assert.equal(normalizeRoom(room({ handoffs: [handoff({ state: "running" })] }), ID, ["waiting"]).handoffs, undefined);
  assert.equal(normalizeRoom(room({ handoffs: [handoff({ state: "waiting" })] }), ID, ["waiting"]).handoffs.length, 1);
});

test("a stored outcome is normalized and an invalid one is omitted; unknown fields are not carried over", () => {
  assert.deepEqual(normalizeRoom(room({ lastOutcome: { kind: "turns", requestId: "r", extra: 1 } }), ID, STATES).lastOutcome, { kind: "turns", requestId: "r" });
  assert.equal("lastOutcome" in normalizeRoom(room({ lastOutcome: { kind: "bad", requestId: "r" } }), ID, STATES), false);
  assert.equal("secret" in normalizeRoom(room({ secret: "x" }), ID, STATES), false);
});

test("the input record is not mutated", () => {
  const input = room({ members: ["a", "a"], messages: [message(), null] });
  const snapshot = JSON.stringify(input);
  normalizeRoom(input, ID, STATES);
  assert.equal(JSON.stringify(input), snapshot);
});

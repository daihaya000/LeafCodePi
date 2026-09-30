import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectRelayParticipants, consumeRelayEnvelope, issueRelayEnvelope, MAX_ROOM_RELAY_DEPTH,
  parentRelayEnvelopeRejection, relayBotIsActive, relayEnvelopeRejection, RELAY_ENVELOPE_TTL_MS,
} from "./room-relay.mjs";

const ROOM_ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const room = (overrides = {}) => ({ id: ROOM_ID, name: "R", members: ["a", "b", "c"], botRelayEnabled: true, createdAt: "c", updatedAt: "u", messages: [], ...overrides });

function world({ rooms = { [ROOM_ID]: room() }, disabled = [], now = 1_000, state } = {}) {
  const calls = [];
  const file = state ?? { envelopes: {}, claims: {} };
  const deps = {
    withRoomLock: (roomId, action) => { calls.push(`lock:${roomId}`); return action(); },
    getRoom: (roomId) => { calls.push(`getRoom:${roomId}`); return rooms[roomId]; },
    isBotEnabled: (botId) => { calls.push(`enabled:${botId}`); return !disabled.includes(botId); },
    readState: (roomId) => { calls.push(`read:${roomId}`); return file; },
    writeState: (roomId, next) => { calls.push(`write:${roomId}`); Object.assign(file, next); },
    now: () => now,
    uuid: (() => { let n = 0; return () => `id-${++n}`; })(),
  };
  return { calls, file, deps, setNow: (value) => { now = value; } };
}

test("relay activity needs membership and an enabled bot", () => {
  const enabled = () => true;
  assert.equal(relayBotIsActive(room(), "a", enabled), true);
  assert.equal(relayBotIsActive(room(), "z", enabled), false);
  assert.equal(relayBotIsActive(room(), "a", () => false), false);
  assert.equal(relayBotIsActive(undefined, "a", enabled), false);
  assert.equal(relayBotIsActive({ members: undefined }, "a", enabled), false);
});

test("participants combine relay claims with the messages stamped for that turn", () => {
  const state = { envelopes: {}, claims: { t1: ["a"], t2: ["z"] } };
  const messages = [
    { relayTurnId: "t1", sourceBotId: "b", botId: "c" },
    { relayTurnId: "t2", botId: "y" },
    { relayTurnId: "t1", botId: "c" },
    {},
  ];
  assert.deepEqual([...collectRelayParticipants({ messages }, state, "t1")].sort(), ["a", "b", "c"]);
  assert.deepEqual([...collectRelayParticipants(undefined, state, "t1")], ["a"]);
  assert.deepEqual([...collectRelayParticipants({ messages }, state, "missing")], []);
});

test("a parent envelope must be consumed, same-room, unexpired and have called on the source", () => {
  const parent = { roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"], turnId: "t1", depth: 0, consumed: true, expiresAt: 2_000 };
  assert.equal(parentRelayEnvelopeRejection(undefined, undefined, ROOM_ID, "b", 1_000), false);
  assert.equal(parentRelayEnvelopeRejection("p", parent, ROOM_ID, "b", 1_000), false);
  assert.equal(parentRelayEnvelopeRejection("p", undefined, ROOM_ID, "b", 1_000), true);
  assert.equal(parentRelayEnvelopeRejection("p", { ...parent, consumed: false }, ROOM_ID, "b", 1_000), true);
  assert.equal(parentRelayEnvelopeRejection("p", { ...parent, roomId: "other" }, ROOM_ID, "b", 1_000), true);
  assert.equal(parentRelayEnvelopeRejection("p", { ...parent, expiresAt: 1_000 }, ROOM_ID, "b", 1_000), true);
  assert.equal(parentRelayEnvelopeRejection("p", { ...parent, targetBotIds: ["c"] }, ROOM_ID, "b", 1_000), true);
});

test("a claimed envelope is rejected for every liveness, shape and involvement problem", () => {
  const base = { roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"], turnId: "t1", depth: 0, consumed: false, expiresAt: 2_000 };
  const context = (overrides = {}) => ({ room: room(), roomId: ROOM_ID, nowMs: 1_000, isBotEnabled: () => true, isTargetInvolved: () => false, ...overrides });
  assert.equal(relayEnvelopeRejection(base, context()), false);
  assert.equal(relayEnvelopeRejection(undefined, context()), true);
  assert.equal(relayEnvelopeRejection(base, context({ room: undefined })), true);
  assert.equal(relayEnvelopeRejection(base, context({ room: room({ botRelayEnabled: false }) })), true);
  assert.equal(relayEnvelopeRejection({ ...base, roomId: "other" }, context()), true);
  assert.equal(relayEnvelopeRejection({ ...base, consumed: true }, context()), true);
  assert.equal(relayEnvelopeRejection({ ...base, expiresAt: 1_000 }, context()), true);
  assert.equal(relayEnvelopeRejection(base, context({ isBotEnabled: (id) => id !== "a" })), true);
  assert.equal(relayEnvelopeRejection(base, context({ isBotEnabled: (id) => id !== "b" })), true);
  assert.equal(relayEnvelopeRejection({ ...base, targetBotIds: [] }, context()), true);
  assert.equal(relayEnvelopeRejection({ ...base, targetBotIds: "b" }, context()), true);
  assert.equal(relayEnvelopeRejection({ ...base, targetBotIds: ["a"] }, context()), true);
  assert.equal(relayEnvelopeRejection(base, context({ room: room({ members: ["a"] }) })), true);
  assert.equal(relayEnvelopeRejection(base, context({ isTargetInvolved: () => true })), true);
});

test("issuing creates a zero-depth envelope under the room lock and returns only an opaque token", () => {
  const w = world();
  const token = issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b", "b", "c"] }, w.deps);
  // A fresh turn gets its own id first, then the token; neither is a client-supplied field.
  assert.equal(token, "id-2");
  assert.deepEqual(w.file.envelopes[token], {
    roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b", "c"], turnId: "id-1", depth: 0, parentId: undefined,
    consumed: false, expiresAt: 1_000 + RELAY_ENVELOPE_TTL_MS,
  });
  assert.equal(w.calls[0], `lock:${ROOM_ID}`);
  assert.equal(w.calls.at(-1), `write:${ROOM_ID}`);
});

test("issuing is refused when relay is off, the source or a target is not active, targets are empty or a parent is bad", () => {
  const cases = [
    [{}, { rooms: { [ROOM_ID]: room({ botRelayEnabled: false }) } }],
    [{}, { rooms: { [ROOM_ID]: undefined } }],
    [{ sourceBotId: "z" }, {}],
    [{ targetBotIds: [] }, {}],
    [{ targetBotIds: ["a"] }, {}],
    [{ targetBotIds: ["z"] }, {}],
    [{ sourceBotId: "x", targetBotIds: ["b"] }, { rooms: { [ROOM_ID]: room({ members: ["x", "b"] }), }, disabled: ["x"] }],
    [{ parentId: "missing" }, {}],
  ];
  for (const [input, options] of cases) {
    const w = world(options);
    assert.equal(issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"], ...input }, w.deps), undefined, JSON.stringify(input));
    assert.deepEqual(w.file.envelopes, {}, "nothing may be written when refused");
  }
  const disabledTarget = world({ disabled: ["c"] });
  assert.equal(issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b", "c"] }, disabledTarget.deps), undefined);
});

test("issuing from a consumed parent increments depth, reuses the turn and stops above the cap", () => {
  const parent = { roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"], turnId: "turn-1", depth: 0, consumed: true, expiresAt: 5_000 };
  const w = world({ state: { envelopes: { p: parent }, claims: {} } });
  const token = issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "b", targetBotIds: ["c"], parentId: "p" }, w.deps);
  assert.equal(token, "id-1");
  assert.equal(w.file.envelopes[token].depth, 1);
  assert.equal(w.file.envelopes[token].turnId, "turn-1");
  assert.equal(w.file.envelopes[token].parentId, "p");

  const atCap = { ...parent, depth: MAX_ROOM_RELAY_DEPTH, targetBotIds: ["b"] };
  for (const depth of [MAX_ROOM_RELAY_DEPTH, MAX_ROOM_RELAY_DEPTH + 1]) {
    const capped = world({ state: { envelopes: { p: { ...atCap, depth } }, claims: {} } });
    assert.equal(issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "b", targetBotIds: ["c"], parentId: "p" }, capped.deps), undefined, `depth ${depth + 1}`);
  }
});

test("issuing refuses targets that already took part in the turn", () => {
  const w = world({ state: { envelopes: {}, claims: { "id-1": ["c"] } } });
  assert.equal(issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b", "c"] }, w.deps), undefined);
  const viaMessage = world({ rooms: { [ROOM_ID]: room({ messages: [{ relayTurnId: "id-1", botId: "b" }] }) } });
  assert.equal(issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"] }, viaMessage.deps), undefined);
});

test("consuming marks the envelope used, records the claims and returns the envelope without secrets", () => {
  const envelope = { roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b", "c"], turnId: "t1", depth: 2, consumed: false, expiresAt: 5_000 };
  // The source bot is already claimed for the turn; the targets are not, so the claim goes through.
  const w = world({ state: { envelopes: { tok: envelope }, claims: { t1: ["a"] } } });
  const consumed = consumeRelayEnvelope({ roomId: ROOM_ID, token: "tok" }, w.deps);
  assert.deepEqual(consumed, {
    roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b", "c"], turnId: "t1", depth: 2,
  });
  // The capability token itself is never handed back to the caller.
  assert.deepEqual(Object.keys(consumed).sort(), ["depth", "roomId", "sourceBotId", "targetBotIds", "turnId"]);
  assert.deepEqual([...w.file.claims.t1].sort(), ["a", "b", "c"]);
  // Second consumption of the same token is refused, and no extra claim is written.
  const writes = w.calls.filter((call) => call.startsWith("write:")).length;
  assert.equal(consumeRelayEnvelope({ roomId: ROOM_ID, token: "tok" }, w.deps), undefined);
  assert.equal(w.calls.filter((call) => call.startsWith("write:")).length, writes);
});

test("consuming is refused for an unknown, foreign, expired, disabled or already involved envelope", () => {
  const envelope = { roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"], turnId: "t1", depth: 0, consumed: false, expiresAt: 5_000 };
  const cases = [
    ["unknown", { rooms: {} }, { envelopes: {}, claims: {} }],
    ["tok", { rooms: { [ROOM_ID]: room({ botRelayEnabled: false }) } }, { envelopes: { tok: envelope }, claims: {} }],
    ["tok", { disabled: ["a"] }, { envelopes: { tok: envelope }, claims: {} }],
    ["tok", { disabled: ["b"] }, { envelopes: { tok: envelope }, claims: {} }],
    ["tok", { rooms: { [ROOM_ID]: room({ members: ["a"] }) } }, { envelopes: { tok: envelope }, claims: {} }],
    ["tok", {}, { envelopes: { tok: { ...envelope, roomId: "other" } }, claims: {} }],
    ["tok", {}, { envelopes: { tok: { ...envelope, consumed: true } }, claims: {} }],
    ["tok", {}, { envelopes: { tok: { ...envelope, expiresAt: 1_000 } }, claims: {} }],
    ["tok", {}, { envelopes: { tok: { ...envelope, targetBotIds: [] } }, claims: {} }],
    ["tok", {}, { envelopes: { tok: envelope }, claims: { t1: ["b"] } }],
  ];
  for (const [token, options, state] of cases) {
    const w = world({ ...options, state });
    assert.equal(consumeRelayEnvelope({ roomId: ROOM_ID, token }, w.deps), undefined, JSON.stringify(options));
  }
});

test("a room with relay turned off loses both issuing and consuming, with no write", () => {
  const w = world({ rooms: { [ROOM_ID]: room({ botRelayEnabled: false }) } });
  assert.equal(issueRelayEnvelope({ roomId: ROOM_ID, sourceBotId: "a", targetBotIds: ["b"] }, w.deps), undefined);
  assert.equal(consumeRelayEnvelope({ roomId: ROOM_ID, token: "tok" }, w.deps), undefined);
  assert.equal(w.calls.some((call) => call.startsWith("write:")), false);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomFileStore } from "./room-store.mjs";

const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const envelope = (overrides = {}) => ({ roomId: ID, sourceBotId: "a", targetBotIds: ["b"], turnId: "t1", depth: 1, consumed: false, expiresAt: 1, ...overrides });
const state = { envelopes: { token1: envelope() }, claims: { t1: ["b"] } };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-room-relay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roomsRoot = join(root, "bots", "rooms");
  return { root, roomsRoot, store: new RoomFileStore({ roomsRoot: () => roomsRoot, handoffStates: [] }) };
}

test("the relay state file is relay.json inside the room's data directory", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(store.relayStatePath(ID), join(roomsRoot, ID, "relay.json"));
  assert.throws(() => store.relayStatePath("../evil"), /invalid room id/);
});

test("a missing, malformed or invalid-id relay file reads as an empty state; malformed content is kept aside", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: {} });
  assert.deepEqual(store.readRelayState("../evil"), { envelopes: {}, claims: {} });
  mkdirSync(store.roomDataRoot(ID), { recursive: true });
  writeFileSync(store.relayStatePath(ID), "{not json");
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: {} });
  // The corrupt original is preserved under a .corrupt- name instead of being overwritten later.
  assert.equal(existsSync(join(roomsRoot, ID, "relay.json")), false);
  const kept = readdirSync(join(roomsRoot, ID)).filter((name) => name.startsWith("relay.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(roomsRoot, ID, kept[0]), "utf8"), "{not json");
  store.writeRelayState(ID, state);
  assert.deepEqual(store.readRelayState(ID), state);
});

test("a relay file that exists but cannot be read is never overwritten by a write", (t) => {
  const { store } = fixture(t);
  mkdirSync(store.roomDataRoot(ID), { recursive: true });
  // A directory named relay.json makes the read fail with EISDIR (not ENOENT).
  mkdirSync(store.relayStatePath(ID));
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: {} });
  assert.throws(() => store.writeRelayState(ID, state), /refusing to overwrite/);
  assert.equal(statSync(store.relayStatePath(ID)).isDirectory(), true);
  rmSync(store.relayStatePath(ID), { recursive: true });
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: {} });
  store.writeRelayState(ID, state);
  assert.deepEqual(store.readRelayState(ID), state);
});

test("non-object envelopes/claims fall back to empty objects, other fields dropped, arrays kept as read", (t) => {
  const { store } = fixture(t);
  mkdirSync(store.roomDataRoot(ID), { recursive: true });
  for (const invalid of ["nope", 7, null, true]) {
    writeFileSync(store.relayStatePath(ID), JSON.stringify({ envelopes: invalid, claims: invalid, extra: 1 }));
    assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: {} }, String(invalid));
  }
  // typeof [] is "object", so an array is passed through exactly as stored (pre-existing behavior).
  writeFileSync(store.relayStatePath(ID), JSON.stringify({ envelopes: [1, 2], claims: ["a"] }));
  assert.deepEqual(store.readRelayState(ID), { envelopes: [1, 2], claims: ["a"] });
  writeFileSync(store.relayStatePath(ID), JSON.stringify({ envelopes: { t: envelope() } }));
  assert.deepEqual(store.readRelayState(ID), { envelopes: { t: envelope() }, claims: {} });
});

test("a written state is compact with a trailing newline and reads back unchanged", (t) => {
  const { store } = fixture(t);
  store.writeRelayState(ID, state);
  const written = readFileSync(store.relayStatePath(ID), "utf8");
  // Compact on purpose: relay.json is machine-read state rewritten on every tick.
  assert.equal(written, `${JSON.stringify(state)}\n`);
  assert.ok(written.length < JSON.stringify(state, null, 2).length);
  assert.deepEqual(store.readRelayState(ID), state);
  // Writing replaces the previous state rather than merging.
  store.writeRelayState(ID, { envelopes: {}, claims: { t2: ["a"] } });
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: { t2: ["a"] } });
});

test("writing creates the room data directory and leaves no temporary file behind on success", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(existsSync(join(roomsRoot, ID)), false);
  store.writeRelayState(ID, state);
  assert.deepEqual(readdirSync(join(roomsRoot, ID)), ["relay.json"]);
  assert.equal(store.readRelayState(ID).envelopes.token1.turnId, "t1");
});

test("an invalid room id throws on write and never creates a relay file", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.throws(() => store.writeRelayState("../evil", state), /invalid room id/);
  assert.equal(existsSync(join(roomsRoot, "..", "evil", "relay.json")), false);
});

test("a failed write keeps the previous state readable for the next reader", (t) => {
  const { store } = fixture(t);
  store.writeRelayState(ID, state);
  const circular = { envelopes: {}, claims: {} };
  circular.self = circular;
  assert.throws(() => store.writeRelayState(ID, circular));
  assert.deepEqual(store.readRelayState(ID), state);
});

test("two rooms keep independent relay state", (t) => {
  const { store } = fixture(t);
  const other = "0f0f0f0f-aaaa-bbbb-cccc-000000000002";
  store.writeRelayState(ID, state);
  assert.deepEqual(store.readRelayState(other), { envelopes: {}, claims: {} });
  store.writeRelayState(other, { envelopes: {}, claims: { t9: ["z"] } });
  assert.deepEqual(store.readRelayState(ID), state);
  assert.deepEqual(store.readRelayState(other), { envelopes: {}, claims: { t9: ["z"] } });
});

test("an unchanged relay state is not written again", (t) => {
  const { store } = fixture(t);
  const path = store.relayStatePath(ID);
  store.writeRelayState(ID, state);
  const firstStamp = statSync(path).mtimeMs;
  const firstInode = statSync(path).ino;
  // A tick that pruned nothing must not churn the file.
  store.writeRelayState(ID, { ...state });
  assert.equal(statSync(path).mtimeMs, firstStamp);
  assert.equal(statSync(path).ino, firstInode);

  // A real change still lands.
  store.writeRelayState(ID, { envelopes: {}, claims: { t9: ["z"] } });
  assert.notEqual(statSync(path).ino, firstInode);
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: { t9: ["z"] } });
});

test("a repeated write of the same state object is skipped without rewriting", (t) => {
  const { store } = fixture(t);
  const path = store.relayStatePath(ID);
  const state = { envelopes: { e1: { roomId: ID, expiresAt: Date.now() + 1000 } }, claims: {} };
  store.writeRelayState(ID, state);
  const first = statSync(path);
  // Identity check only: no timestamp trickery, so an unchanged state means no write.
  store.writeRelayState(ID, state);
  assert.equal(statSync(path).mtimeMs, first.mtimeMs);
  assert.equal(statSync(path).ino, first.ino);

  // A new object with different content still lands.
  store.writeRelayState(ID, { envelopes: {}, claims: { t1: ["a"] } });
  assert.notEqual(statSync(path).ino, first.ino);
  assert.deepEqual(store.readRelayState(ID), { envelopes: {}, claims: { t1: ["a"] } });
});

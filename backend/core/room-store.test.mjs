import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isValidRoomId, MAX_LIVE_ROOM_MESSAGES, RoomFileStore } from "./room-store.mjs";

const STATES = ["waiting", "ready", "running", "done", "failed", "cancelled"];
const id = (n) => `0f0f0f0f-aaaa-bbbb-cccc-${String(n).padStart(12, "0")}`;
const roomAt = (n, overrides = {}) => ({ id: id(n), name: `Room ${n}`, members: ["a"], botRelayEnabled: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messages: [], ...overrides });

function fixture(t, onWritten) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-room-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roomsRoot = join(root, "bots", "rooms");
  return { root, roomsRoot, store: new RoomFileStore({ roomsRoot: () => roomsRoot, handoffStates: STATES, onWritten }) };
}

test("room ids follow the existing UUID-shaped rule, and assertId throws for anything else", (t) => {
  assert.equal(isValidRoomId(id(1)), true);
  for (const bad of ["", "abc", "../escape", "0f0f0f0f-aaaa", `${id(1)}/../x`, "GGGGGGGG-aaaa-bbbb-cccc-000000000001"]) assert.equal(isValidRoomId(bad), false, bad);
  const { store } = fixture(t);
  assert.throws(() => store.assertId("../x"), /invalid room id/);
  assert.throws(() => store.roomPath("../x"), /invalid room id/);
});

test("construction and reads touch no disk, and a missing or invalid room reads as undefined", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(store.readRoom(id(1)), undefined);
  assert.equal(store.readRoom("../x"), undefined);
  assert.deepEqual(store.listRooms(), []);
  assert.equal(existsSync(roomsRoot), false);
});

test("a written room is pretty-printed JSON with a trailing newline, read back normalized, and announced once", (t) => {
  const events = [];
  const { store, roomsRoot } = fixture(t, (written) => events.push(written.id));
  const value = roomAt(1, { messages: [{ id: "m", role: "user", text: "hi", createdAt: 1 }] });
  store.writeRoom(value);
  assert.equal(readFileSync(join(roomsRoot, `${id(1)}.json`), "utf8"), `${JSON.stringify(value, null, 2)}\n`);
  assert.deepEqual(store.readRoom(id(1)), value);
  assert.deepEqual(events, [id(1)]);
  assert.deepEqual(readdirSync(roomsRoot), [`${id(1)}.json`]);
});

test("the hook receives the very object that was written, after the file exists", (t) => {
  let existedAtNotification = false;
  let received;
  const { store, roomsRoot } = fixture(t, (written) => { received = written; existedAtNotification = existsSync(join(roomsRoot, `${written.id}.json`)); });
  const value = roomAt(2);
  store.writeRoom(value);
  assert.equal(received, value);
  assert.equal(existedAtNotification, true);
});

test("a failed write leaves the previous file intact, removes the temporary file and notifies nobody", (t) => {
  const events = [];
  const { store, roomsRoot } = fixture(t, () => events.push("notified"));
  store.writeRoom(roomAt(3, { name: "Before" }));
  events.length = 0;
  const circular = roomAt(3, { name: "After" });
  circular.self = circular;
  assert.throws(() => store.writeRoom(circular));
  assert.equal(store.readRoom(id(3)).name, "Before");
  assert.deepEqual(readdirSync(roomsRoot), [`${id(3)}.json`]);
  assert.deepEqual(events, []);
});

test("writing a room with an invalid id throws before any room file is created", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.throws(() => store.writeRoom({ ...roomAt(1), id: "../evil" }), /invalid room id/);
  assert.deepEqual(readdirSync(roomsRoot), []);
});

test("listing returns valid rooms newest first and skips corrupt, foreign and mismatched files", (t) => {
  const { store, roomsRoot } = fixture(t);
  store.writeRoom(roomAt(1, { updatedAt: "2026-01-01T00:00:00.000Z" }));
  store.writeRoom(roomAt(2, { updatedAt: "2026-03-01T00:00:00.000Z" }));
  store.writeRoom(roomAt(3, { updatedAt: "2026-02-01T00:00:00.000Z" }));
  writeFileSync(join(roomsRoot, `${id(4)}.json`), "{broken");
  writeFileSync(join(roomsRoot, `${id(5)}.json`), JSON.stringify({ ...roomAt(9) }));
  writeFileSync(join(roomsRoot, "notes.json"), JSON.stringify(roomAt(6)));
  writeFileSync(join(roomsRoot, `${id(7)}.txt`), "x");
  mkdirSync(join(roomsRoot, id(8)));
  mkdirSync(join(roomsRoot, `${id(10)}.json`));
  assert.deepEqual(store.listRooms().map((r) => r.id), [id(2), id(3), id(1)]);
});

test("the root is resolved on every call, following a changing data directory", (t) => {
  const first = mkdtempSync(join(tmpdir(), "leafcode-room-store-a-"));
  const second = mkdtempSync(join(tmpdir(), "leafcode-room-store-b-"));
  t.after(() => { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); });
  let current = first;
  const store = new RoomFileStore({ roomsRoot: () => current, handoffStates: STATES });
  store.writeRoom(roomAt(1));
  current = second;
  assert.equal(store.readRoom(id(1)), undefined);
  assert.deepEqual(store.listRooms(), []);
  current = first;
  assert.equal(store.readRoom(id(1)).id, id(1));
});

test("the injected handoff vocabulary decides which stored handoffs survive a read", (t) => {
  const { store, roomsRoot } = fixture(t);
  mkdirSync(roomsRoot, { recursive: true });
  const handoff = { id: "h", requestId: "r", fromMessageId: "m", fromBotId: "a", toBotId: "b", task: "t", state: "running", createdAt: 1 };
  writeFileSync(join(roomsRoot, `${id(1)}.json`), JSON.stringify(roomAt(1, { handoffs: [handoff] })));
  assert.equal(store.readRoom(id(1)).handoffs.length, 1);
  const narrow = new RoomFileStore({ roomsRoot: () => roomsRoot, handoffStates: ["waiting"] });
  assert.equal(narrow.readRoom(id(1)).handoffs, undefined);
});

test("plain Node writes and lists rooms without importing the Web app", (t) => {
  const { root } = fixture(t);
  const moduleUrl = new URL("./room-store.mjs", import.meta.url).href;
  const code = `
    import { join } from "node:path";
    import { RoomFileStore } from ${JSON.stringify(moduleUrl)};
    const store = new RoomFileStore({ roomsRoot: () => join(${JSON.stringify(root)}, "rooms"), handoffStates: [] });
    store.writeRoom(${JSON.stringify(roomAt(1))});
    console.log(JSON.stringify(store.listRooms().map((r) => r.id)));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), [id(1)]);
});


const message = (n) => ({ id: `m-${n}`, role: "user", text: `msg ${n}`, createdAt: n });

test("archiving is a no-op at or under the live cap and never touches history", (t) => {
  const { store, roomsRoot } = fixture(t);
  const room = roomAt(1, { messages: [message(1), message(2)] });
  assert.equal(store.archiveOverflow(room, 2), 0);
  assert.equal(room.messages.length, 2);
  assert.equal(existsSync(join(roomsRoot, id(1), "history.jsonl")), false);
});

test("archiving moves exactly the oldest overflow into the append-only history and keeps the newest messages live", (t) => {
  const { store, roomsRoot } = fixture(t);
  const live = [message(1), message(2), message(3), message(4), message(5)];
  const room = roomAt(1, { messages: [...live] });
  assert.equal(store.archiveOverflow(room, 3), 2);
  assert.deepEqual(room.messages.map((m) => m.id), ["m-3", "m-4", "m-5"]);
  const history = join(roomsRoot, id(1), "history.jsonl");
  assert.equal(readFileSync(history, "utf8"), `${[1, 2].map((n) => JSON.stringify(message(n))).join("\n")}\n`);
  // A second overflow appends rather than replacing the history.
  room.messages.push(message(6), message(7));
  assert.equal(store.archiveOverflow(room, 3), 2);
  assert.equal(readFileSync(history, "utf8").trim().split("\n").length, 4);
  assert.deepEqual(room.messages.map((m) => m.id), ["m-5", "m-6", "m-7"]);
});

test("the live cap defaults to the shared constant and can be overridden by the caller", (t) => {
  assert.equal(MAX_LIVE_ROOM_MESSAGES, 500);
  const { store } = fixture(t);
  const full = roomAt(1, { messages: Array.from({ length: 503 }, (_, index) => message(index)) });
  assert.equal(store.archiveOverflow(full), 3);
  assert.equal(full.messages.length, MAX_LIVE_ROOM_MESSAGES);
  assert.equal(full.messages[0].id, "m-3");
});

test("the data directory is the room file's sibling directory named after the room id", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(store.roomDataRoot(id(1)), join(roomsRoot, id(1)));
  assert.equal(store.roomDataRoot("not-a-uuid"), join(roomsRoot, "not-a-uuid"));
});

test("re-archiving messages that already reached history does not duplicate them", (t) => {
  const { store, roomsRoot } = fixture(t);
  const make = () => roomAt(1, { messages: [1, 2, 3, 4, 5].map(message) });
  assert.equal(store.archiveOverflow(make(), 3), 2);
  // The room file write failed after the first archive: the same overflow comes back.
  assert.equal(store.archiveOverflow(make(), 3), 2);
  const history = join(roomsRoot, id(1), "history.jsonl");
  assert.deepEqual(readFileSync(history, "utf8").trim().split("\n").map((line) => JSON.parse(line).id), ["m-1", "m-2"]);
});

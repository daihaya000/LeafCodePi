import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomFileStore, ROOM_IMAGE_EXTENSIONS } from "./room-store.mjs";

const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const MESSAGE_ID = "1a1a1a1a-aaaa-bbbb-cccc-000000000002";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-room-attachments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roomsRoot = join(root, "bots", "rooms");
  return { root, roomsRoot, store: new RoomFileStore({ roomsRoot: () => roomsRoot, handoffStates: [] }) };
}

test("image files live under <room>/images with a validated server-generated name", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(store.roomImagePath(ID, `${MESSAGE_ID}-0.png`), join(roomsRoot, ID, "images", `${MESSAGE_ID}-0.png`));
  // The extension check is case-insensitive, as before, and keeps the caller's spelling.
  assert.equal(store.roomImagePath(ID, `${MESSAGE_ID}-11.WEBP`), join(roomsRoot, ID, "images", `${MESSAGE_ID}-11.WEBP`));
  for (const bad of ["../../etc/passwd", `${MESSAGE_ID}-0.png/../x`, `../${MESSAGE_ID}-0.png`, `${MESSAGE_ID}-0.bmp`, `${MESSAGE_ID}-0.png.bak`, "abc.png", `${MESSAGE_ID}-0.exe`]) {
    assert.throws(() => store.roomImagePath(ID, bad), /invalid room image/, bad);
  }
  assert.throws(() => store.roomImagePath("../evil", `${MESSAGE_ID}-0.png`), /invalid room id/);
});

test("attachment files use the .dat pattern and the same room-id validation", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(store.roomFilePath(ID, `${MESSAGE_ID}-3.dat`), join(roomsRoot, ID, "files", `${MESSAGE_ID}-3.dat`));
  for (const bad of ["../../x.dat", `${MESSAGE_ID}-3.dat.bak`, `${MESSAGE_ID}-3.txt`, "notes.dat", `${MESSAGE_ID}-3.`]) {
    assert.throws(() => store.roomFilePath(ID, bad), /invalid room file/, bad);
  }
  assert.throws(() => store.roomFilePath("nope", `${MESSAGE_ID}-3.dat`), /invalid room id/);
});

test("a stored image reads back with the MIME type derived from its extension", (t) => {
  const { store } = fixture(t);
  mkdirSync(join(store.roomDataRoot(ID), "images"), { recursive: true });
  for (const [mimeType, extension] of Object.entries(ROOM_IMAGE_EXTENSIONS)) {
    const name = `${MESSAGE_ID}-0.${extension}`;
    writeFileSync(store.roomImagePath(ID, name), Buffer.from([1, 2, 3]));
    const stored = store.readRoomImage(ID, name);
    assert.equal(stored.mimeType, mimeType);
    assert.deepEqual([...stored.bytes], [1, 2, 3]);
  }
});

test("an unknown extension, a missing file, an invalid room id or an escaping name all read as undefined", (t) => {
  const { store } = fixture(t);
  assert.equal(store.readRoomImage(ID, `${MESSAGE_ID}-0.bmp`), undefined);
  assert.equal(store.readRoomImage(ID, `${MESSAGE_ID}-0.png`), undefined);
  assert.equal(store.readRoomImage("../evil", `${MESSAGE_ID}-0.png`), undefined);
  assert.equal(store.readRoomImage(ID, "../../etc/passwd"), undefined);
  assert.equal(store.readRoomFile(ID, `${MESSAGE_ID}-0.dat`), undefined);
  assert.equal(store.readRoomFile(ID, "../../evil.dat"), undefined);
  // A directory in place of the file is a read failure, not a crash.
  mkdirSync(store.roomImagePath(ID, `${MESSAGE_ID}-0.png`), { recursive: true });
  assert.equal(store.readRoomImage(ID, `${MESSAGE_ID}-0.png`), undefined);
});

test("a stored attachment reads back as raw bytes and never as an image", (t) => {
  const { store } = fixture(t);
  mkdirSync(join(store.roomDataRoot(ID), "files"), { recursive: true });
  writeFileSync(store.roomFilePath(ID, `${MESSAGE_ID}-0.dat`), Buffer.from("hello", "utf8"));
  assert.deepEqual([...store.readRoomFile(ID, `${MESSAGE_ID}-0.dat`).bytes], [...Buffer.from("hello", "utf8")]);
  assert.equal(store.readRoomImage(ID, `${MESSAGE_ID}-0.dat`), undefined);
});

test("reading never creates directories or files", (t) => {
  const { store, roomsRoot } = fixture(t);
  assert.equal(store.readRoomImage(ID, `${MESSAGE_ID}-0.png`), undefined);
  assert.equal(store.readRoomFile(ID, `${MESSAGE_ID}-0.dat`), undefined);
  assert.equal(existsSync(roomsRoot), false);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_BOOKMARKS_PER_TASK,
  MAX_BOOKMARK_PREVIEW_CHARS,
  TaskBookmarkStore,
  isBookmarkTaskId,
} from "./task-bookmark-store.mjs";

const TASK = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const OTHER = "0f0f0f0f-aaaa-bbbb-cccc-000000000002";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-bookmarks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "data", "task-bookmarks.json");
  let clock = 1_000;
  const warnings = [];
  const store = new TaskBookmarkStore({ filePath: () => file, now: () => (clock += 1), onCorrupt: (error) => warnings.push(error) });
  return { root, file, store, warnings };
}

const input = (messageId, overrides = {}) => ({
  messageId,
  role: "assistant",
  messageCreatedAt: 100,
  preview: `preview of ${messageId}`,
  ...overrides,
});

test("task ids are restricted to the id alphabet", () => {
  assert.equal(isBookmarkTaskId(TASK), true);
  for (const id of ["", "../x", "a/b", "a:b", "a b", ".hidden", "x".repeat(129), undefined, 12]) {
    assert.equal(isBookmarkTaskId(id), false, String(id));
  }
});

test("an empty store lists nothing and creates no file", (t) => {
  const { store, file } = fixture(t);
  assert.deepEqual(store.list(TASK), []);
  assert.deepEqual(store.list("../bad"), []);
  assert.equal(existsSync(file), false);
});

test("bookmarks are stored per task in timeline order and add is idempotent", (t) => {
  const { store } = fixture(t);
  store.add(TASK, input("late", { messageCreatedAt: 300 }));
  store.add(TASK, input("early", { messageCreatedAt: 100, role: "user" }));
  const list = store.add(TASK, input("middle", { messageCreatedAt: 200 }));
  assert.deepEqual(list.map((bookmark) => bookmark.messageId), ["early", "middle", "late"]);
  assert.equal(list[0].role, "user");
  assert.ok(list.every((bookmark) => bookmark.createdAt > 1_000));

  const again = store.add(TASK, input("early", { preview: "changed" }));
  assert.equal(again.length, 3);
  assert.equal(again[0].preview, "preview of early");
  assert.deepEqual(store.list(OTHER), []);
  assert.deepEqual(store.list(TASK).map((bookmark) => bookmark.messageId), ["early", "middle", "late"]);
});

test("remove drops one bookmark, tolerates unknown ones and forgets an emptied task", (t) => {
  const { store, file } = fixture(t);
  store.add(TASK, input("a"));
  store.add(TASK, input("b"));
  assert.deepEqual(store.remove(TASK, "a").map((bookmark) => bookmark.messageId), ["b"]);
  assert.deepEqual(store.remove(TASK, "missing").map((bookmark) => bookmark.messageId), ["b"]);
  assert.deepEqual(store.remove(TASK, "b"), []);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, tasks: {} });
  assert.deepEqual(store.remove(OTHER, "x"), []);
});

test("input is validated and previews are collapsed and bounded", (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.add("../bad", input("a")), { status: 400 });
  assert.throws(() => store.add(TASK, input("msg-3")), { status: 400 });
  assert.throws(() => store.add(TASK, input("a", { role: "system" })), { status: 400 });
  assert.throws(() => store.add(TASK, null), { status: 400 });
  assert.throws(() => store.remove("../bad", "a"), { status: 400 });

  const long = `  line1\n\n   line2 ${"あ".repeat(500)}  `;
  const [bookmark] = store.add(TASK, input("a", { preview: long, messageCreatedAt: -5 }));
  assert.ok(bookmark.preview.startsWith("line1 line2 あ"));
  assert.equal(Array.from(bookmark.preview).length, MAX_BOOKMARK_PREVIEW_CHARS);
  assert.ok(bookmark.preview.endsWith("…"));
  assert.equal(bookmark.messageCreatedAt, 0);
  assert.equal(store.add(TASK, input("b", { preview: undefined }))[1].preview, "");
});

test("a task holds at most MAX_BOOKMARKS_PER_TASK bookmarks", (t) => {
  const { store, file } = fixture(t);
  store.add(TASK, input("seed"));
  const seeded = JSON.parse(readFileSync(file, "utf8"));
  seeded.tasks[TASK] = Array.from({ length: MAX_BOOKMARKS_PER_TASK }, (_, index) => ({
    messageId: `m${index}`, role: "user", messageCreatedAt: index, createdAt: index, preview: "",
  }));
  writeFileSync(file, JSON.stringify(seeded), "utf8");
  assert.throws(() => store.add(TASK, input("overflow")), { status: 409 });
  assert.equal(store.add(TASK, input("m0")).length, MAX_BOOKMARKS_PER_TASK);
  assert.equal(store.remove(TASK, "m0").length, MAX_BOOKMARKS_PER_TASK - 1);
  assert.equal(store.add(TASK, input("overflow")).length, MAX_BOOKMARKS_PER_TASK);
});

test("adding prunes tasks that no longer exist, but never on an empty known set", (t) => {
  const { store } = fixture(t);
  store.add(OTHER, input("x"));
  store.add(TASK, input("a"), { knownTaskIds: new Set() });
  assert.equal(store.list(OTHER).length, 1);
  store.add(TASK, input("b"), { knownTaskIds: new Set([TASK]) });
  assert.deepEqual(store.list(OTHER), []);
  assert.equal(store.list(TASK).length, 2);
});

test("a corrupt file is backed up before it is replaced", (t) => {
  const { store, file, root } = fixture(t);
  store.add(TASK, input("a"));
  writeFileSync(file, "{not json", "utf8");
  assert.deepEqual(store.list(TASK), []);
  const list = store.add(TASK, input("b"));
  assert.deepEqual(list.map((bookmark) => bookmark.messageId), ["b"]);
  const backups = readdirSync(join(root, "data")).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(root, "data", backups[0]), "utf8"), "{not json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tasks[TASK].map((bookmark) => bookmark.messageId), ["b"]);
});

test("malformed entries in a valid file are dropped on read", (t) => {
  const { store, file } = fixture(t);
  store.add(TASK, input("keep"));
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.tasks[TASK].push({ messageId: "msg-9", role: "user" }, { messageId: "keep", role: "user" }, null, { role: "user" });
  stored.tasks["../bad"] = [{ messageId: "x", role: "user" }];
  writeFileSync(file, JSON.stringify(stored), "utf8");
  assert.deepEqual(store.list(TASK).map((bookmark) => bookmark.messageId), ["keep"]);
});

test("a write leaves no temporary file behind", (t) => {
  const { store, root } = fixture(t);
  store.add(TASK, input("a"));
  store.remove(TASK, "a");
  const names = readdirSync(join(root, "data"));
  assert.ok(names.includes("task-bookmarks.json"));
  assert.ok(!names.some((name) => name.endsWith(".tmp")), names.join(","));
});

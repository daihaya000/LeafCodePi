import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertSessionLoadAllowed, isRuntimeMemoryPressure, MAX_SESSION_LOAD_BYTES, MAX_RETAINED_SESSION_IMAGE_CHARS, openSessionManagerSafely, readRuntimeMemory } from "./session-memory-guard.mjs";
const MIB = 1024 * 1024;
const readMemory = () => ({ heapUsed: 1024 * MIB, heapLimit: 4096 * MIB });
function setup(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "session-memory-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id: "session-1", cwd: dir, timestamp: "2026-10-07T00:00:00Z" };
  writeFileSync(source, `${[header, ...entries].map(JSON.stringify).join("\n")}\nmalformed-row\n`);
  const stat = (file, options) => {
    const value = statSync(file, options);
    return file === source ? { ...value, size: options?.bigint ? BigInt(MAX_SESSION_LOAD_BYTES + 1) : MAX_SESSION_LOAD_BYTES + 1 } : value;
  };
  return { dir, source, options: { readMemory, stat, tempRoot: dir } };
}
const message = (id, parentId, content) => ({ type: "message", id, parentId, timestamp: "2026-10-07T00:00:00Z", message: { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 1 } });
const image = (data) => ({ type: "image", data, mimeType: "image/png" });
const checkpoint = (id, parentId, kept) => ({ type: "compaction", id, parentId, firstKeptEntryId: kept, summary: "compacted", tokensBefore: 100, timestamp: "2026-10-07T00:00:00Z" });

test("allows small history and new sessions with sufficient headroom", () => {
  assertSessionLoadAllowed("small", { stat: () => ({ size: 20 * MIB }), readMemory });
  assertSessionLoadAllowed(null, { stat: () => assert.fail("must not stat"), readMemory });
  assertSessionLoadAllowed("boundary", { stat: () => ({ size: MAX_SESSION_LOAD_BYTES }), readMemory });
});
test("rejects even new sessions at pressure boundary", () => {
  assert.throws(() => assertSessionLoadAllowed(null, { readMemory: () => ({ heapUsed: 3072 * MIB, heapLimit: 4096 * MIB }) }), { status: 503 });
  assert.equal(isRuntimeMemoryPressure({ heapUsed: 512 * MIB, heapLimit: 1024 * MIB }), true);
  assert.equal(isRuntimeMemoryPressure({ heapUsed: 511 * MIB, heapLimit: 1024 * MIB }), false);
});
test("slims only inactive results, preserves current context verbatim and appends to source (real SDK)", (t) => {
  const old = message("old", null, [image("a".repeat(MIB)), { type: "text", text: "x".repeat(100_000) }]);
  const active = message("new", "old", [image("b".repeat(MIB)), { type: "text", text: "y".repeat(100_000) }]);
  const { dir, source, options } = setup(t, [old, active, checkpoint("compact", "new", "new")]);
  const original = readFileSync(source);
  const full = SessionManager.open(source);
  const expected = full.buildSessionContext();
  const manager = openSessionManagerSafely(source, (file, sessionDir) => SessionManager.open(file, sessionDir), options);
  assert.deepEqual(manager.buildSessionContext(), expected);
  assert.equal(manager.getSessionFile(), source);
  assert.equal(manager.getSessionDir(), dir);
  assert.equal(manager.getSessionId(), full.getSessionId());
  assert.match(manager.getEntry("old").message.content.at(-1).text, /omitted in memory/);
  assert.deepEqual(readFileSync(source), original);
  const leaf = manager.getLeafId();
  assert.throws(() => manager.branch("old"), { code: "SESSION_FULL_HISTORY_REQUIRED", status: 409 });
  assert.throws(() => manager.createBranchedSession(leaf), { code: "SESSION_FULL_HISTORY_REQUIRED" });
  assert.throws(() => manager._rewriteFile(), { code: "SESSION_FULL_HISTORY_REQUIRED" });
  assert.equal(manager.getLeafId(), leaf, "refusal happens before leaf changes");
  assert.deepEqual(readFileSync(source), original);
  manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
  const after = readFileSync(source);
  assert.deepEqual(after.subarray(0, original.length), original, "existing bytes survive real SDK append");
  assert.equal(SessionManager.open(source).getEntryCount(), full.getEntryCount() + 1);
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});
test("refuses excessive ACTIVE images instead of silently deleting current vision input", (t) => {
  const { source, options } = setup(t, [message("a", null, [image("x".repeat(9 * MIB))]), message("b", "a", [image("y".repeat(9 * MIB))])]);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), options), { code: "SESSION_ACTIVE_IMAGES_TOO_LARGE" });
});
test("compaction on unrelated branch does not hide current images", (t) => {
  const { source, options } = setup(t, [message("root", null, [image("a")]), checkpoint("other", "root", "other"), message("leaf", "root", [image("b")])]);
  const manager = openSessionManagerSafely(source, (file, dir) => SessionManager.open(file, dir), options);
  assert.equal(manager.getEntry("root").message.content[0].data, "a");
  assert.equal(manager.getEntry("leaf").message.content[0].data, "b");
});
test("disk-full and zero/partial-write errors propagate and temp files are removed", (t) => {
  const { source, dir, options } = setup(t, [message("a", null, [{ type: "text", text: "hello" }])]);
  const original = readFileSync(source);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), { ...options, write: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } }), { code: "ENOSPC" });
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), { ...options, write: () => 0 }), { code: "SESSION_SLIM_WRITE_FAILED" });
  const manager = openSessionManagerSafely(source, (file) => ({ entries: readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) }), { ...options, write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, Math.min(13, length)) });
  assert.equal(manager.entries.length, 2);
  assert.deepEqual(readFileSync(source), original);
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});
test("rejects source mutations before and after SDK open", (t) => {
  const { source, dir, options } = setup(t, []);
  let count = 0;
  assert.throws(() => openSessionManagerSafely(source, () => ({}), { ...options, stat: (...args) => {
    if (++count === 2) writeFileSync(source, "changed\n", { flag: "a" });
    return options.stat(...args);
  } }), { code: "SESSION_CHANGED_DURING_SLIM" });
  assert.throws(() => openSessionManagerSafely(source, () => { writeFileSync(source, "changed-again\n", { flag: "a" }); return {}; }, options), { code: "SESSION_CHANGED_DURING_SLIM" });
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});
test("legacy format and SDK callback failures never modify source", (t) => {
  const { source, dir, options } = setup(t, []);
  const original = readFileSync(source);
  assert.throws(() => openSessionManagerSafely(source, () => { throw new Error("SDK fail"); }, options), /SDK fail/);
  assert.deepEqual(readFileSync(source), original);
  writeFileSync(source, `${JSON.stringify({ type: "session", version: 2, id: "s", cwd: dir })}\n`);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), options), { code: "SESSION_LEGACY_TOO_LARGE" });
});
test("missing newline is refused without source repair or later append corruption", (t) => {
  const { source, options } = setup(t, []);
  const body = readFileSync(source, "utf8").trimEnd();
  writeFileSync(source, body);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), options), { code: "SESSION_FINAL_NEWLINE_REQUIRED", status: 409 });
  assert.equal(readFileSync(source, "utf8"), body);
});
test("oversized lines and excessive entry counts stop before SDK allocation", (t) => {
  const { source, options } = setup(t, []);
  const header = readFileSync(source, "utf8").split("\n")[0];
  writeFileSync(source, `${header}\n${JSON.stringify(message("long", null, [{ type: "text", text: "x".repeat(17 * MIB) }]))}\n`);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), options), { code: "SESSION_LINE_TOO_LARGE" });
  writeFileSync(source, `${header}\n${'{}\n'.repeat(100_001)}`);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), options), { code: "SESSION_ENTRY_LIMIT" });
});
test("pressure refuses before scanner allocation and numeric metrics stay bounded", (t) => {
  const { source, options } = setup(t, []);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), { ...options, readMemory: () => ({ heapUsed: 3200 * MIB, heapLimit: 4096 * MIB }) }), { code: "SESSION_MEMORY_PRESSURE" });
  for (const value of Object.values(readRuntimeMemory())) assert.ok(Number.isFinite(value) && value >= 0);
});

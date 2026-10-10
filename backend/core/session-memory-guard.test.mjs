import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
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
function sourceDigest(source) {
  return createHash("sha256").update(readFileSync(source)).digest("hex");
}
function largeMessages(role) {
  const text = "x".repeat(14 * MIB);
  return Array.from({ length: 5 }, (_, i) => ({
    ...message(`large-${i}`, i === 0 ? null : `large-${i - 1}`, [{ type: "text", text }]),
    message: role === "toolResult"
      ? message(`large-${i}`, null, [{ type: "text", text }]).message
      : { role, content: text, timestamp: i },
  }));
}
test("automatically compresses inactive conversation when older-tool slimming still exceeds the limit", (t) => {
  const old = largeMessages("user");
  const state = { type: "custom", id: "state", parentId: "large-4", customType: "extension-state", data: { enabled: true } };
  const model = { type: "model_change", id: "model", parentId: "state", provider: "test", modelId: "model-1" };
  const active = { ...message("current", "model", []), message: { role: "user", content: "current request", timestamp: 6 } };
  const { source, dir, options } = setup(t, [...old, state, model, active, checkpoint("compact", "current", "current")]);
  assert.ok(statSync(source).size > MAX_SESSION_LOAD_BYTES);
  const original = sourceDigest(source);
  const expected = SessionManager.open(source).buildSessionContext();
  const manager = openSessionManagerSafely(source, (file, dir) => SessionManager.open(file, dir), options);
  assert.equal(manager.memorySlimStats.compressionLevel, 1);
  assert.ok(manager.memorySlimStats.loadedBytes < MAX_SESSION_LOAD_BYTES);
  assert.deepEqual(manager.buildSessionContext(), expected);
  assert.deepEqual(manager.getEntry("state"), state, "extension state is preserved even before compaction");
  assert.match(manager.getEntry("large-0").message.content[0].text, /automatically compacted/);
  assert.equal(sourceDigest(source), original);
  const leaf = manager.getLeafId();
  assert.throws(() => manager.branch("large-0"), { code: "SESSION_FULL_HISTORY_REQUIRED" });
  assert.throws(() => manager.createBranchedSession(leaf), { code: "SESSION_FULL_HISTORY_REQUIRED" });
  assert.throws(() => manager._rewriteFile(), { code: "SESSION_FULL_HISTORY_REQUIRED" });
  assert.equal(manager.getLeafId(), leaf);
  manager.appendMessage({ role: "user", content: "continue", timestamp: 7 });
  const reopened = openSessionManagerSafely(source, (file, dir) => SessionManager.open(file, dir), options);
  assert.equal(reopened.buildSessionContext().messages.at(-1).content, "continue");
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});
test("automatically compacts active tool text as a last resort without dropping images or conversation", (t) => {
  const tools = largeMessages("toolResult");
  const user = { ...message("user", "large-4", []), message: { role: "user", content: "keep this request", timestamp: 8 } };
  const request = { ...message("request", null, []), message: { role: "user", content: "run tools", timestamp: 0 } };
  const assistant = {
    ...message("assistant", "request", []),
    message: { role: "assistant", provider: "test", model: "model-1", timestamp: 1, content: tools.map((tool) => ({ type: "toolCall", id: tool.id, name: "read", arguments: {} })) },
  };
  tools[0].parentId = "assistant";
  tools[0].message.content.push(image("b".repeat(MIB)));
  const visual = message("visual", "user", [image("a".repeat(MIB))]);
  const { source, dir, options } = setup(t, [request, assistant, ...tools, user, visual]);
  const original = sourceDigest(source);
  const manager = openSessionManagerSafely(source, (file, dir) => SessionManager.open(file, dir), options);
  assert.equal(manager.memorySlimStats.compressionLevel, 2);
  assert.ok(manager.memorySlimStats.loadedBytes < MAX_SESSION_LOAD_BYTES);
  assert.match(manager.getEntry("large-0").message.content[0].text, /tool output automatically compacted/);
  assert.deepEqual(manager.getEntry("request"), request);
  assert.deepEqual(manager.getEntry("assistant"), assistant, "tool-call arguments and model attribution are unchanged");
  assert.deepEqual(manager.getEntry("large-0").message.content[1], tools[0].message.content[1], "images survive in a result whose text was compacted");
  assert.deepEqual(manager.getEntry("user"), user);
  assert.deepEqual(manager.getEntry("visual"), visual);
  assert.equal(manager.getLeafId(), "visual");
  assert.equal(manager.buildSessionContext().messages.length, 9);
  assert.equal(sourceDigest(source), original);
  assert.throws(() => manager.branch("visual"), { code: "SESSION_FULL_HISTORY_REQUIRED" });
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});
test("automatic compression never discards oversized active user messages or swallows retry write failures", (t) => {
  const { source, dir, options } = setup(t, largeMessages("user"));
  const original = sourceDigest(source);
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), options), { code: "SESSION_SLIM_TOO_LARGE" });
  assert.equal(sourceDigest(source), original);
  // Four 14 MiB lines are written on each pass before the fifth exceeds the limit.
  let writtenBytes = 0;
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), {
    ...options,
    write: (fd, buffer, offset, length) => {
      writtenBytes += length;
      if (writtenBytes > MAX_SESSION_LOAD_BYTES) throw Object.assign(new Error("disk full on retry"), { code: "ENOSPC" });
      return writeSync(fd, buffer, offset, length);
    },
  }), { code: "ENOSPC" });
  assert.equal(sourceDigest(source), original);
  let mutated = false;
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("must not open"), {
    ...options,
    write: (fd, buffer, offset, length) => {
      if (!mutated) {
        mutated = true;
        writeFileSync(source, "concurrent append\n", { flag: "a" });
      }
      return writeSync(fd, buffer, offset, length);
    },
  }), { code: "SESSION_CHANGED_DURING_SLIM" });
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

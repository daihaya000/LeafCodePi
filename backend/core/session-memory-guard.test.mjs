import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSessionLoadAllowed, isRuntimeMemoryPressure, MAX_SESSION_LOAD_BYTES, MAX_RETAINED_SESSION_IMAGE_CHARS, openSessionManagerSafely, readRuntimeMemory } from "./session-memory-guard.mjs";

const MIB = 1024 * 1024;
const readMemory = () => ({ heapUsed: 1024 * MIB, heapLimit: 4096 * MIB });
function padLarge(fd, path, target = MAX_SESSION_LOAD_BYTES + 1) {
  const chunk = Buffer.alloc(1024 * 1024, 0x0a);
  let size = statSync(path).size;
  while (size < target) {
    const count = Math.min(chunk.length, target - size);
    writeSync(fd, chunk, 0, count);
    size += count;
  }
}
function largeJsonl(dir, name, header) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  const fd = openSync(file, "a");
  try { padLarge(fd, file); } finally { closeSync(fd); }
  return file;
}

test("allows small history and new sessions with sufficient headroom", () => {
  assertSessionLoadAllowed("small", { stat: () => ({ size: 20 * MIB }), readMemory });
  assertSessionLoadAllowed(null, { stat: () => { throw new Error("must not stat"); }, readMemory });
  assertSessionLoadAllowed("boundary", { stat: () => ({ size: MAX_SESSION_LOAD_BYTES }), readMemory });
});

test("rejects even new sessions at the pressure boundary; low heap limits keep a minimum reserve", () => {
  assert.throws(() => assertSessionLoadAllowed(null, { readMemory: () => ({ heapUsed: 3072 * MIB, heapLimit: 4096 * MIB }) }), { status: 503 });
  assert.equal(isRuntimeMemoryPressure({ heapUsed: 512 * MIB, heapLimit: 1024 * MIB }), true);
  assert.equal(isRuntimeMemoryPressure({ heapUsed: 511 * MIB, heapLimit: 1024 * MIB }), false);
});

test("slims a large session before SDK open, keeps the newest images, and never rewrites source", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-memory-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "large.jsonl");
  const oldImage = "a".repeat(15 * MIB);
  const newImage = "b".repeat(2 * MIB);
  const entries = [
    { type: "session", version: 3, id: "session-1", cwd: dir },
    { type: "message", id: "old", parentId: null, message: { role: "toolResult", content: [{ type: "image", data: oldImage, mimeType: "image/png" }] } },
    { type: "message", id: "new", parentId: "old", message: { role: "toolResult", content: [{ type: "image", data: newImage, mimeType: "image/png" }] } },
    { type: "message", id: "text", parentId: "new", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(100_000) }] } },
  ];
  writeFileSync(source, `${entries.map(JSON.stringify).join("\n")}\nnot-valid-json\n`);
  const fd = openSync(source, "a");
  try { padLarge(fd, source); } finally { closeSync(fd); }
  const original = readFileSync(source);
  let loaded;
  const manager = openSessionManagerSafely(source, (file, sessionDir) => {
    assert.equal(sessionDir, dir);
    loaded = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    return { sessionFile: file, entries: loaded };
  }, { readMemory, tempRoot: dir });
  assert.equal(manager.sessionFile, source);
  assert.equal(manager.memorySlimmed, true);
  assert.equal(loaded[2].message.content[0].data, newImage, "most recent image remains available");
  assert.equal(loaded[1].message.content[0].type, "text", "old image is replaced by an explanatory marker");
  assert.match(loaded[1].message.content[0].text, /omitted in memory/);
  assert.ok(loaded[3].message.content[0].text.length <= 25_000);
  assert.equal(loaded.length, entries.length, "malformed rows are ignored like the SDK loader");
  assert.ok(manager.memorySlimStats.retainedImageChars <= MAX_RETAINED_SESSION_IMAGE_CHARS);
  assert.ok(manager.memorySlimStats.loadedBytes < MAX_SESSION_LOAD_BYTES);
  assert.deepEqual(readFileSync(source), original, "source history is byte-for-byte unchanged");
});

test("rejects a source modified during slimming and cleans temporary files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-memory-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = largeJsonl(dir, "large.jsonl", { type: "session", version: 3, id: "s", cwd: dir });
  let statCalls = 0;
  assert.throws(() => openSessionManagerSafely(source, () => ({}), {
    readMemory, tempRoot: dir,
    stat: (...args) => {
      statCalls += 1;
      if (statCalls === 2) writeFileSync(source, "changed\n", { flag: "a" });
      return statSync(...args);
    },
  }), { code: "SESSION_CHANGED_DURING_SLIM" });
  assert.deepEqual(readdirSync(dir), ["large.jsonl"]);
});

test("rejects large legacy sessions instead of allowing migration to overwrite the source", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-memory-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = largeJsonl(dir, "legacy.jsonl", { type: "session", version: 2, id: "s", cwd: dir });
  const before = statSync(source).size;
  assert.throws(() => openSessionManagerSafely(source, () => assert.fail("SDK must not open"), { readMemory, tempRoot: dir }), { code: "SESSION_LEGACY_TOO_LARGE" });
  assert.equal(statSync(source).size, before);
});

test("runtime metrics contain only finite numeric values", () => {
  for (const value of Object.values(readRuntimeMemory())) assert.ok(Number.isFinite(value) && value >= 0);
});

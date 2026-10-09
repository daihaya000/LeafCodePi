import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readIndexedSession, resetSessionLogIndex, sessionLogIndexDiagnostics, SESSION_INDEX_MAX_BYTES, SESSION_PAGE_MAX_BYTES } from "./session-log-index.mjs";
const header = { type: "session", version: 3, id: "session", cwd: "/", timestamp: "2026-10-09T00:00:00Z" };
const row = (id, parentId, content = id) => ({ type: "message", id, parentId, message: { role: "user", content } });
function setup(t, rows = []) {
  resetSessionLogIndex(); const root = mkdtempSync(join(tmpdir(), "session-index-test-")), file = join(root, "session.jsonl");
  t.after(() => { resetSessionLogIndex(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(file, [header, ...rows].map(JSON.stringify).join("\n") + "\n"); return { root, file };
}
const classify = (entry) => ({ role: entry.message?.role ?? null });
const read = (file, select = (branch) => ({ ids: branch.slice(-1).map((row) => row.id) }), signal) => readIndexedSession(file, { kind: "test", classify, select, signal });
test("caches only offsets and parses selected rows on repeated requests without writing source", async (t) => {
  const { file } = setup(t, [row("old", null, "history".repeat(100_000)), row("tail", "old", "日本語😀")]);
  const before = readFileSync(file), first = await read(file), diagnostics = sessionLogIndexDiagnostics();
  assert.equal(first.entries[0].message.content, "日本語😀");
  for (let i = 0; i < 5; i++) await read(file);
  const after = sessionLogIndexDiagnostics();
  assert.equal(after.scannedBytes, diagnostics.scannedBytes); assert.equal(after.parsedRows - diagnostics.parsedRows, 5);
  assert.equal(after.branchBuilds, diagnostics.branchBuilds, "warm requests reuse the validated branch");
  assert.ok(after.cacheBytes < 2048); assert.equal(after.descriptors, 0); assert.equal(after.readers, 0);
  assert.deepEqual(readFileSync(file), before);
});
test("invalidates on append, same-size rewrite and file replacement", async (t) => {
  const { file } = setup(t, [row("a", null)]); await read(file);
  appendFileSync(file, JSON.stringify(row("b", "a")) + "\n"); assert.equal((await read(file)).entries[0].id, "b");
  const original = readFileSync(file, "utf8"), changed = original.replace('"content":"b"', '"content":"c"');
  writeFileSync(file, changed); assert.equal((await read(file)).entries[0].message.content, "c");
  rmSync(file); writeFileSync(file, original); assert.equal((await read(file)).entries[0].message.content, "b");
});
test("follows current branch and refuses orphan/cycle ancestry", async (t) => {
  const { file } = setup(t, [row("root", null), row("other", "root"), row("leaf", "root")]);
  const all = await read(file, (branch) => ({ ids: branch.map((r) => r.id) })); assert.deepEqual(all.entries.map((r) => r.id), ["root", "leaf"]);
  appendFileSync(file, JSON.stringify(row("orphan", "missing")) + "\n"); await assert.rejects(read(file), { code: "SESSION_INDEX_STRUCTURE" });
  writeFileSync(file, [header, row("a", "b"), row("b", "a")].map(JSON.stringify).join("\n")); await assert.rejects(read(file), { code: "SESSION_INDEX_STRUCTURE" });
});
test("refuses changes during selection, malformed header and excessive page size", async (t) => {
  const { file } = setup(t, [row("a", null)]);
  await assert.rejects(read(file, (branch) => { appendFileSync(file, JSON.stringify(row("b", "a")) + "\n"); return { ids: branch.map((r) => r.id) }; }), { code: "SESSION_INDEX_CHANGED", status: 409 });
  assert.equal(sessionLogIndexDiagnostics().cacheEntries, 0);
  writeFileSync(file, JSON.stringify({ ...header, version: 2 }) + "\n"); await assert.rejects(read(file), { code: "SESSION_INDEX_LEGACY" });
  writeFileSync(file, [header, row("a", null, "x".repeat(9 * 1024 * 1024)), row("b", "a", "x".repeat(9 * 1024 * 1024))].map(JSON.stringify).join("\n"));
  await assert.rejects(read(file, (branch) => ({ ids: branch.map((r) => r.id) })), { code: "SESSION_PAGE_LIMIT" });
  assert.equal(SESSION_PAGE_MAX_BYTES, 16 * 1024 * 1024); assert.equal(SESSION_INDEX_MAX_BYTES, 8 * 1024 * 1024);
});
test("reports selected-row corruption during a warm read as a generation conflict", async (t) => {
  const { file } = setup(t, [row("a", null)]); await read(file);
  const original = readFileSync(file, "utf8");
  await assert.rejects(read(file, (branch) => {
    writeFileSync(file, original.replace('"content":"a"', '"content":xxx'));
    return { ids: [branch[0].id] };
  }), { code: "SESSION_INDEX_CHANGED", status: 409 });
  assert.equal(sessionLogIndexDiagnostics().cacheEntries, 0);
  assert.equal(sessionLogIndexDiagnostics().descriptors, 0);
});
test("a warm row replaced with null or invalid UTF-8 also yields 409 and evicts its index", async (t) => {
  const { file } = setup(t, [row("a", null)]), original = readFileSync(file);
  const start = original.indexOf(10) + 1, end = original.indexOf(10, start);
  for (const mode of ["null", "utf8"]) {
    writeFileSync(file, original); await read(file);
    await assert.rejects(read(file, (branch) => {
      const changed = Buffer.from(original);
      if (mode === "utf8") changed[start] = 255;
      else { changed.fill(32, start, end); changed.write("null", start); }
      writeFileSync(file, changed); return { ids: [branch[0].id] };
    }), { code: "SESSION_INDEX_CHANGED", status: 409 });
    assert.equal(sessionLogIndexDiagnostics().cacheEntries, 0);
    assert.equal(sessionLogIndexDiagnostics().descriptors, 0);
  }
});
test("bounds LRU entries and releases readers on cancellation and malformed JSON", async (t) => {
  const { root, file } = setup(t, [row("a", null)]);
  for (let i = 0; i < 6; i++) { const copy = join(root, `${i}.jsonl`); writeFileSync(copy, readFileSync(file)); await read(copy); }
  assert.equal(sessionLogIndexDiagnostics().cacheEntries, 4);
  const controller = new AbortController(); controller.abort(); await assert.rejects(read(file, undefined, controller.signal), { name: "AbortError" });
  appendFileSync(file, "malformed-row\n"); assert.equal((await read(file)).entries[0].id, "a");
  assert.equal(sessionLogIndexDiagnostics().descriptors, 0); assert.equal(sessionLogIndexDiagnostics().readers, 0);
});
test("serializes readers, caps the queue and removes cancelled waiters", async (t) => {
  const { file } = setup(t, [row("a", null)]), controller = new AbortController();
  const running = read(file), cancelled = read(file, undefined, controller.signal);
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  const queued = Array.from({ length: 16 }, () => read(file));
  await assert.rejects(read(file), { code: "SESSION_INDEX_BUSY", status: 503 });
  await Promise.all([running, ...queued]);
  const after = sessionLogIndexDiagnostics(); assert.equal(after.waiters, 0); assert.equal(after.readers, 0); assert.equal(after.descriptors, 0);
});
test("frozen branch metadata cannot poison later readers and reserved fields fail closed", async (t) => {
  const { file } = setup(t, [row("a", null), row("b", "a")]);
  await read(file, (branch) => {
    assert.ok(Object.isFrozen(branch)); assert.ok(Object.isFrozen(branch[0]));
    assert.throws(() => { branch[0].offset = 0; }, TypeError);
    assert.throws(() => { branch.reverse(); }, TypeError);
    return { ids: [branch.at(-1).id] };
  });
  assert.equal((await read(file)).entries[0].id, "b");
  await assert.rejects(readIndexedSession(file, { kind: "poison", classify: () => ({ offset: 0 }), select: () => ({ ids: [] }) }), { code: "SESSION_INDEX_METADATA", status: 500 });
  assert.equal(sessionLogIndexDiagnostics().readers, 0);
});
test("reused row buffer never exposes bytes from the preceding longer row", async (t) => {
  const { file } = setup(t, [row("a", null, "long output".repeat(10_000)), row("b", "a", "短文😀")]);
  const all = await read(file, (branch) => ({ ids: branch.map((item) => item.id) }));
  assert.equal(all.entries[1].message.content, "短文😀");
  assert.equal((await read(file)).entries[0].message.content, "短文😀");
});
test("256MiB repeated history reads stay below the unchanged 48MiB heap-growth ceiling", async (t) => {
  const { file } = setup(t);
  const MIB = 1024 * 1024, large = "x".repeat(2 * MIB);
  const hash = createHash("sha256"); hash.update(readFileSync(file));
  let parent = null;
  for (let i = 0; i < 128; i++) { const line = JSON.stringify(row(`old-${i}`, parent, large)) + "\n"; appendFileSync(file, line); hash.update(line); parent = `old-${i}`; }
  const tail = JSON.stringify(row("tail", parent, "recent context")) + "\n"; appendFileSync(file, tail); hash.update(tail);
  const originalHash = hash.digest("hex");
  await read(file); global.gc?.();
  const initial = process.memoryUsage().heapUsed, before = sessionLogIndexDiagnostics(); let peak = initial;
  for (let i = 0; i < 12; i++) { assert.equal((await read(file)).entries[0].id, "tail"); peak = Math.max(peak, process.memoryUsage().heapUsed); }
  assert.ok(peak - initial < 48 * MIB, `heap growth ${peak - initial}`);
  assert.equal(sessionLogIndexDiagnostics().scannedBytes, before.scannedBytes);
  assert.equal(sessionLogIndexDiagnostics().parsedRows - before.parsedRows, 12);
  // Hash in bounded chunks instead of reloading 256MiB into the test's heap.
  const { open } = await import("node:fs/promises"), source = await open(file, "r"), output = createHash("sha256"), buffer = Buffer.allocUnsafe(MIB);
  try { let n; while ((n = (await source.read(buffer, 0, buffer.length, null)).bytesRead)) output.update(buffer.subarray(0, n)); } finally { await source.close(); }
  assert.equal(output.digest("hex"), originalHash);
  t.diagnostic(`256MiB repeated reads heap growth: ${(peak - initial) / MIB} MiB`);
});

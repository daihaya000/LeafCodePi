import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MIB = 1024 * 1024;
export const SESSION_INDEX_MAX_BYTES = 8 * MIB;
export const SESSION_PAGE_MAX_BYTES = 16 * MIB;
const MAX_FILE = 512 * MIB, MAX_LINE = 16 * MIB, MAX_ENTRIES = 100_000;
const indexes = new Map();
let cacheBytes = 0, busy = false;
const waiters = [];
let lineBuffer;
const metrics = { scannedBytes: 0, parsedRows: 0, selectedBytes: 0, cacheHits: 0, branchBuilds: 0, descriptors: 0 };
const fail = (code, status = 413) => Object.assign(new Error("Session history cannot be read within the safe budget"), { code, status });
const generation = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
function forget(key) { const prior = indexes.get(key); if (prior) { cacheBytes -= prior.bytes; indexes.delete(key); } }
function remember(key, index) {
  forget(key);
  while (indexes.size >= 4 || cacheBytes + index.bytes > SESSION_INDEX_MAX_BYTES) forget(indexes.keys().next().value);
  indexes.set(key, index); cacheBytes += index.bytes;
}
export function resetSessionLogIndex() { indexes.clear(); cacheBytes = 0; }
export function sessionLogIndexDiagnostics() { return { ...metrics, cacheBytes, cacheEntries: indexes.size, readers: Number(busy), waiters: waiters.length }; }
async function acquire(signal) {
  signal?.throwIfAborted();
  if (busy) {
    if (waiters.length >= 16) throw fail("SESSION_INDEX_BUSY", 503);
    await new Promise((resolve, reject) => {
      const abort = () => { const at = waiters.indexOf(ready); if (at >= 0) { waiters.splice(at, 1); reject(signal.reason); } };
      const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
      waiters.push(ready); signal?.addEventListener("abort", abort, { once: true });
    });
  } else busy = true;
  return () => { const next = waiters.shift(); if (next) next(); else busy = false; };
}
/** Cache only descriptor-verified offsets/ancestry and bounded scalar metadata, never payloads. */
export async function readIndexedSession(path, { kind, classify, select, signal }) {
  path = resolve(path);
  const key = `${kind}:${path}`, release = await acquire(signal);
  let file;
  try {
    const deadline = Date.now() + 8_000;
    const check = () => { signal?.throwIfAborted(); if (Date.now() > deadline) throw fail("SESSION_INDEX_TIMEOUT", 503); };
    check();
    if (await realpath(path) !== path) throw fail("SESSION_INDEX_PATH", 403);
    file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)); metrics.descriptors++;
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || generation(await stat(path, { bigint: true })) !== generation(before)) throw fail("SESSION_INDEX_CHANGED", 409);
    if (before.size > BigInt(MAX_FILE)) throw fail("SESSION_INDEX_FILE_LIMIT");
    let index = indexes.get(key);
    if (index?.version !== generation(before)) {
      forget(key);
      lineBuffer ??= Buffer.allocUnsafe(MAX_LINE);
      const scratch = Buffer.allocUnsafe(65536), rows = new Map();
      let used = 0, position = 0, leaf = null, header = false, bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const emit = (end) => {
        const length = used; used = 0;
        if (!length) return;
        let entry;
        try { entry = JSON.parse(decoder.decode(lineBuffer.subarray(0, length))); metrics.parsedRows++; } catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) return; throw error; }
        if (!header) { if (entry?.type !== "session" || entry.version !== 3) throw fail("SESSION_INDEX_LEGACY", 409); header = true; return; }
        if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 512 ||
          (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length > 512)) || rows.has(entry.id)) throw fail("SESSION_INDEX_STRUCTURE", 409);
        const metadata = classify(entry);
        // Classifiers are internal; scalar-only metadata prevents accidental transcript retention.
        if (!metadata || ["id", "parentId", "offset", "length"].some((key) => Object.hasOwn(metadata, key)) ||
          Object.values(metadata).some((v) => v !== null && !["string", "number", "boolean"].includes(typeof v))) throw fail("SESSION_INDEX_METADATA", 500);
        // Include the cached branch array + membership Set in the metadata budget.
        bytes += 416 + 2 * (entry.id.length + (entry.parentId?.length ?? 0) + JSON.stringify(metadata).length);
        if (bytes > SESSION_INDEX_MAX_BYTES || rows.size >= MAX_ENTRIES) throw fail("SESSION_INDEX_ENTRY_LIMIT");
        rows.set(entry.id, Object.freeze({ ...metadata, id: entry.id, parentId: entry.parentId, offset: end - length, length })); leaf = entry.id;
      };
      while (position < Number(before.size)) {
        check();
        const size = Math.min(scratch.length, Number(before.size) - position);
        const { bytesRead } = await file.read(scratch, 0, size, position);
        if (bytesRead !== size) throw fail("SESSION_INDEX_CHANGED", 409);
        metrics.scannedBytes += size;
        let start = 0;
        while (start < size) {
          let end = scratch.indexOf(10, start); if (end < 0 || end >= size) end = size;
          if (used + end - start > MAX_LINE) throw fail("SESSION_INDEX_LINE_LIMIT");
          scratch.copy(lineBuffer, used, start, end); used += end - start;
          if (end < size) { emit(position + end); start = end + 1; } else start = size;
        }
        position += size;
      }
      emit(position);
      if (!header) throw fail("SESSION_INDEX_LEGACY", 409);
      const branch = [], activeIds = new Set();
      for (let id = leaf; id; ) {
        const row = rows.get(id);
        if (!row || activeIds.has(id)) throw fail("SESSION_INDEX_STRUCTURE", 409);
        activeIds.add(id); branch.push(row); id = row.parentId;
      }
      branch.reverse(); metrics.branchBuilds++;
      index = { version: generation(before), rows, branch: Object.freeze(branch), activeIds, bytes };
      check();
      if (generation(await file.stat({ bigint: true })) !== index.version || generation(await stat(path, { bigint: true })) !== index.version || await realpath(path) !== path) throw fail("SESSION_INDEX_CHANGED", 409);
      remember(key, index);
    } else metrics.cacheHits++;
    const selection = select(index.branch);
    const selected = [...new Set(selection.ids)];
    let total = 0;
    for (const id of selected) {
      const row = index.rows.get(id);
      if (!row || !index.activeIds.has(id)) throw fail("SESSION_INDEX_SELECTION", 409);
      total += row.length;
      if (total > SESSION_PAGE_MAX_BYTES) throw fail("SESSION_PAGE_LIMIT");
    }
    const entries = [];
    for (const id of selected) {
      check();
      // The reader lease also owns this reusable buffer; no per-row Buffer allocation.
      const row = index.rows.get(id), buffer = lineBuffer;
      let position = 0;
      while (position < row.length) {
        check(); const n = Math.min(65536, row.length - position);
        const { bytesRead } = await file.read(buffer, position, n, row.offset + position);
        if (bytesRead !== n) throw fail("SESSION_INDEX_CHANGED", 409);
        position += n;
      }
      metrics.selectedBytes += row.length;
      const entry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, row.length))); metrics.parsedRows++;
      if (entry.id !== id) throw fail("SESSION_INDEX_CHANGED", 409);
      entries.push(entry);
    }
    check();
    if (generation(await file.stat({ bigint: true })) !== index.version || generation(await stat(path, { bigint: true })) !== index.version || await realpath(path) !== path) throw fail("SESSION_INDEX_CHANGED", 409);
    remember(key, index);
    return { entries, selection };
  } catch (error) { if (error?.code === "SESSION_INDEX_CHANGED" || error?.code === "ENOENT") forget(key); throw error; }
  finally { try { if (file) { try { await file.close(); } finally { metrics.descriptors--; } } } finally { release(); } }
}

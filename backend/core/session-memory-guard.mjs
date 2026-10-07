import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getHeapStatistics } from "node:v8";

const MIB = 1024 * 1024;
export const MAX_SESSION_LOAD_BYTES = 64 * MIB;
export const MIN_SESSION_LOAD_RESERVE_BYTES = 512 * MIB;
export const SESSION_LOAD_EXPANSION_FACTOR = 8;
export const MAX_SESSION_LINE_BYTES = 16 * MIB;
export const MAX_RETAINED_SESSION_IMAGE_CHARS = 16 * MIB;
export const MAX_RETAINED_TOOL_RESULT_CHARS = 25_000;
const CURRENT_SESSION_VERSION = 3;

export function readRuntimeMemory() {
  const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage();
  return { heapUsed, heapLimit: getHeapStatistics().heap_size_limit, rss, external, arrayBuffers };
}

export function isRuntimeMemoryPressure(memory) {
  return memory.heapLimit - memory.heapUsed <= Math.max(MIN_SESSION_LOAD_RESERVE_BYTES, memory.heapLimit * 0.25);
}

function dispatchJsonlLine(line, onEntry) {
  if (!line.trim()) return;
  try {
    const entry = JSON.parse(line);
    // Match SessionManager.loadEntriesFromFile(): malformed and JSON-null rows are ignored.
    if (entry) onEntry(entry);
  } catch { /* Ignore malformed JSONL rows, as the SDK does. */ }
}

function scanJsonl(file, onEntry) {
  const fd = openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let pendingBytes = 0;
  const consume = (text) => {
    let start = 0;
    while (true) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      const segment = text.slice(start, newline);
      const complete = `${pending}${segment}`.replace(/\r$/, "");
      if (pendingBytes + Buffer.byteLength(segment) > MAX_SESSION_LINE_BYTES) throw Object.assign(new Error("Session JSONL line exceeds safe scan limit"), { code: "SESSION_LINE_TOO_LARGE" });
      dispatchJsonlLine(complete, onEntry);
      pending = "";
      pendingBytes = 0;
      start = newline + 1;
    }
    const tail = text.slice(start);
    pending += tail;
    pendingBytes += Buffer.byteLength(tail);
    if (pendingBytes > MAX_SESSION_LINE_BYTES) throw Object.assign(new Error("Session JSONL line exceeds safe scan limit"), { code: "SESSION_LINE_TOO_LARGE" });
  };
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      consume(decoder.write(buffer.subarray(0, count)));
    }
    pending += decoder.end();
    if (Buffer.byteLength(pending) > MAX_SESSION_LINE_BYTES) throw Object.assign(new Error("Session JSONL line exceeds safe scan limit"), { code: "SESSION_LINE_TOO_LARGE" });
    dispatchJsonlLine(pending, onEntry);
  } finally {
    closeSync(fd);
  }
}

function contentOf(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  return message && message.role === "toolResult" && Array.isArray(message.content) ? message.content : null;
}

function imageChars(content) {
  let chars = 0;
  for (const part of content ?? []) if (part?.type === "image" && typeof part.data === "string") chars += part.data.length;
  return chars;
}

function selectRecentImageEntries(file) {
  let header;
  let leafId = null;
  const byId = new Map();
  const images = [];
  scanJsonl(file, (entry) => {
    if (!header && entry?.type === "session") header = entry;
    if (entry?.type === "session") return;
    if (typeof entry?.id === "string") {
      leafId = entry.id;
      byId.set(entry.id, { parentId: entry.parentId ?? null, type: entry.type, firstKeptEntryId: entry.firstKeptEntryId });
    }
    const chars = imageChars(contentOf(entry));
    if (chars > 0) images.push({ id: entry.id, chars });
  });
  if (!header || header.version !== CURRENT_SESSION_VERSION) {
    throw Object.assign(new Error("Large legacy session cannot be safely slimmed without changing its format"), { code: "SESSION_LEGACY_TOO_LARGE", status: 413 });
  }
  // Keep images reachable from the actual leaf. Older branches are preserved on disk and
  // can be reopened independently; they must not consume this live session's image budget.
  const path = [];
  const visited = new Set();
  for (let id = leafId; id && !visited.has(id);) {
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    path.push({ id, ...entry });
    id = entry.parentId;
  }
  path.reverse();
  let compactionIndex = -1;
  for (let index = 0; index < path.length; index += 1) if (path[index].type === "compaction") compactionIndex = index;
  let activeIds = new Set(path.map((entry) => entry.id));
  if (compactionIndex >= 0) {
    const compaction = path[compactionIndex];
    const keptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    activeIds = new Set([compaction.id, ...path.slice(keptIndex < 0 ? compactionIndex : keptIndex, compactionIndex).map((entry) => entry.id), ...path.slice(compactionIndex + 1).map((entry) => entry.id)]);
  }
  const keep = new Set();
  let retained = 0;
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const item = images[index];
    if (activeIds.has(item.id) && retained + item.chars <= MAX_RETAINED_SESSION_IMAGE_CHARS) {
      keep.add(item.id);
      retained += item.chars;
    }
  }
  return { keep, retained };
}

function slimToolResult(entry, keepImage) {
  const content = contentOf(entry);
  if (!content) return entry;
  let remaining = MAX_RETAINED_TOOL_RESULT_CHARS;
  let omittedImage = false;
  let omittedText = false;
  let changed = false;
  const next = [];
  for (const part of content) {
    if (part?.type === "image" && typeof part.data === "string") {
      if (keepImage) next.push(part);
      else { omittedImage = true; changed = true; }
      continue;
    }
    if (part?.type === "text" && typeof part.text === "string") {
      if (part.text.length > remaining) {
        if (!omittedText) {
          const marker = "\n[older tool output omitted in memory; original session file is unchanged]";
          const head = Math.max(0, remaining - marker.length);
          next.push({ ...part, text: `${part.text.slice(0, head)}${marker}` });
          omittedText = true;
        }
        changed = true;
        remaining = 0;
      } else {
        next.push(part);
        remaining -= part.text.length;
      }
    } else next.push(part);
  }
  if (omittedImage) next.push({ type: "text", text: "[older tool-result image omitted in memory; original session file is unchanged]" });
  if (!changed) return entry;
  return { ...entry, message: { ...entry.message, content: next } };
}

/**
 * Open a large session through a temporary, bounded projection. The source JSONL is never modified;
 * the returned manager persists future appends to the original file. Old tool-result images and
 * oversized tool text are omitted only from this process's in-memory tree.
 */
export function openSessionManagerSafely(sourceFile, openSession, {
  readMemory = readRuntimeMemory,
  stat = statSync,
  tempRoot = tmpdir(),
} = {}) {
  const before = stat(sourceFile, { bigint: true });
  if (before.size <= BigInt(MAX_SESSION_LOAD_BYTES)) {
    assertMemoryHeadroom(Number(before.size), readMemory());
    return openSession(sourceFile, dirname(sourceFile));
  }
  const { keep, retained } = selectRecentImageEntries(sourceFile);
  const directory = mkdtempSync(join(tempRoot, "leafcode-session-slim-"));
  const slimFile = join(directory, "session.jsonl");
  let fd;
  try {
    fd = openSync(slimFile, "wx");
    scanJsonl(sourceFile, (entry) => {
      const content = contentOf(entry);
      const sanitized = content ? slimToolResult(entry, keep.has(entry.id)) : entry;
      writeSync(fd, `${JSON.stringify(sanitized)}\n`);
    });
    closeSync(fd);
    fd = undefined;
    const after = stat(sourceFile, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== after.ino) {
      throw Object.assign(new Error("Session changed while its memory-safe copy was being prepared; retry the operation"), { code: "SESSION_CHANGED_DURING_SLIM", status: 409 });
    }
    const slimBytes = stat(slimFile).size;
    if (slimBytes > MAX_SESSION_LOAD_BYTES) {
      throw Object.assign(new Error("Session remains too large after omitting old tool results; original file is unchanged"), { code: "SESSION_SLIM_TOO_LARGE", status: 413 });
    }
    assertMemoryHeadroom(slimBytes, readMemory());
    const manager = openSession(slimFile, dirname(sourceFile));
    // SessionManager appends to this path. Its in-memory entries intentionally omit bulky old data.
    const runtimeManager = manager;
    runtimeManager.sessionFile = sourceFile;
    runtimeManager.memorySlimmed = true;
    runtimeManager.memorySlimStats = { sourceBytes: Number(before.size), retainedImageChars: retained, loadedBytes: slimBytes };
    return manager;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertMemoryHeadroom(bytes, memory) {
  const reserve = Math.max(MIN_SESSION_LOAD_RESERVE_BYTES, memory.heapLimit * 0.25);
  if (isRuntimeMemoryPressure(memory) || memory.heapUsed + bytes * SESSION_LOAD_EXPANSION_FACTOR + reserve > memory.heapLimit) {
    throw Object.assign(new Error("Backend memory headroom is insufficient to open this session; close idle sessions and retry"), { status: 503, code: "SESSION_MEMORY_PRESSURE" });
  }
}

/** Used by cold-list projections that cannot materialize oversized session histories. */
export function assertSessionLoadAllowed(file, { readMemory = readRuntimeMemory, stat = statSync } = {}) {
  const bytes = file ? stat(file).size : 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SESSION_LOAD_BYTES) {
    throw Object.assign(new Error("Session history exceeds the direct-read limit; open it through the memory-safe session loader"), { status: 413, code: "SESSION_FILE_TOO_LARGE" });
  }
  assertMemoryHeadroom(bytes, readMemory());
}

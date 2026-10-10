import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getHeapStatistics } from "node:v8";

const MIB = 1024 * 1024;
export const MAX_SESSION_LOAD_BYTES = 64 * MIB;
export const MIN_SESSION_LOAD_RESERVE_BYTES = 512 * MIB;
export const SESSION_LOAD_EXPANSION_FACTOR = 8;
export const MAX_SESSION_LINE_BYTES = 16 * MIB;
export const MAX_RETAINED_SESSION_IMAGE_CHARS = 16 * MIB;
export const MAX_RETAINED_TOOL_RESULT_CHARS = 25_000;
export const MAX_SESSION_ENTRIES = 100_000;
const CURRENT_SESSION_VERSION = 3;

const refusal = (message, code, status = 413) => Object.assign(new Error(message), { code, status });
export function readRuntimeMemory() {
  const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage();
  return { heapUsed, heapLimit: getHeapStatistics().heap_size_limit, rss, external, arrayBuffers };
}
export function isRuntimeMemoryPressure(memory) {
  return memory.heapLimit - memory.heapUsed <= Math.max(MIN_SESSION_LOAD_RESERVE_BYTES, memory.heapLimit * 0.25);
}
function assertMemoryHeadroom(bytes, memory) {
  const reserve = Math.max(MIN_SESSION_LOAD_RESERVE_BYTES, memory.heapLimit * 0.25);
  if (isRuntimeMemoryPressure(memory) || memory.heapUsed + bytes * SESSION_LOAD_EXPANSION_FACTOR + reserve > memory.heapLimit) {
    throw refusal("Backend memory headroom is insufficient to open this session; close idle sessions and retry", "SESSION_MEMORY_PRESSURE", 503);
  }
}
function dispatchJsonlLine(line, onEntry) {
  if (!line.trim()) return;
  let entry;
  try { entry = JSON.parse(line); }
  catch (error) {
    if (error instanceof SyntaxError) return; // Match the SDK's malformed-line handling.
    throw error;
  }
  if (entry) onEntry(entry); // Callback failures MUST propagate, particularly disk-full errors.
}
function scanJsonl(file, onEntry) {
  const fd = openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(MIB);
  let pending = "";
  let pendingBytes = 0;
  let count = 0;
  const emit = (line) => dispatchJsonlLine(line, (entry) => {
    if (++count > MAX_SESSION_ENTRIES) throw refusal("Session contains too many entries for safe indexing", "SESSION_ENTRY_LIMIT");
    onEntry(entry);
  });
  const consume = (text) => {
    let start = 0;
    while (true) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      if (newline === start && !pending) {
        start = newline + 1;
        while (text.charCodeAt(start) === 10) start += 1;
        continue;
      }
      const segment = text.slice(start, newline);
      if (pendingBytes + Buffer.byteLength(segment) > MAX_SESSION_LINE_BYTES) throw refusal("Session JSONL line exceeds safe scan limit", "SESSION_LINE_TOO_LARGE");
      emit(`${pending}${segment}`.replace(/\r$/, ""));
      pending = "";
      pendingBytes = 0;
      start = newline + 1;
    }
    const tail = text.slice(start);
    pendingBytes += Buffer.byteLength(tail);
    if (pendingBytes > MAX_SESSION_LINE_BYTES) throw refusal("Session JSONL line exceeds safe scan limit", "SESSION_LINE_TOO_LARGE");
    pending += tail;
  };
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      consume(decoder.write(buffer.subarray(0, count)));
    }
    consume(decoder.end());
    emit(pending);
  } finally { closeSync(fd); }
}
function contentOf(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  return message?.role === "toolResult" && Array.isArray(message.content) ? message.content : null;
}
function selectActiveEntries(file) {
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
    let chars = 0;
    for (const part of contentOf(entry) ?? []) if (part?.type === "image" && typeof part.data === "string") chars += part.data.length;
    if (chars > 0) images.push({ id: entry.id, chars });
  });
  if (!header || header.version !== CURRENT_SESSION_VERSION) throw refusal("Large legacy session cannot be safely slimmed without changing its format", "SESSION_LEGACY_TOO_LARGE");
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
  let retained = 0;
  for (const item of images) if (activeIds.has(item.id)) retained += item.chars;
  if (retained > MAX_RETAINED_SESSION_IMAGE_CHARS) throw refusal("Active session images exceed the safe memory budget; compact this session before reopening", "SESSION_ACTIVE_IMAGES_TOO_LARGE");
  return { activeIds, retained };
}
function slimToolResult(entry, active, compactActive = false) {
  if (active && !compactActive) return entry; // Preserve current context unless the stronger fallback is needed.
  const content = contentOf(entry);
  if (!content) return entry;
  let remaining = MAX_RETAINED_TOOL_RESULT_CHARS;
  let omittedImage = false;
  let omittedText = false;
  let changed = false;
  const next = [];
  for (const part of content) {
    if (!active && part?.type === "image" && typeof part.data === "string") {
      omittedImage = true;
      changed = true;
    } else if (part?.type === "text" && typeof part.text === "string" && part.text.length > remaining) {
      if (!omittedText) {
        const marker = active
          ? "\n[tool output automatically compacted in memory; full output remains in the original session file]"
          : "\n[older tool output omitted in memory; original session file is unchanged]";
        let head = Math.max(0, remaining - marker.length);
        if (head > 0 && /[\uD800-\uDBFF]/.test(part.text[head - 1])) head -= 1;
        next.push({ ...part, text: `${part.text.slice(0, head)}${marker}` });
        omittedText = true;
      }
      changed = true;
      remaining = 0;
    } else {
      next.push(part);
      if (part?.type === "text" && typeof part.text === "string") remaining -= part.text.length;
    }
  }
  if (omittedImage) next.push({ type: "text", text: "[older tool-result image omitted in memory; original session file is unchanged]" });
  return changed ? { ...entry, message: { ...entry.message, content: next } } : entry;
}
// Only payloads outside the current model context are replaced. Keep tree IDs,
// model attribution and extension state so appends and runtime restoration remain valid.
function compactInactiveEntry(entry) {
  const marker = "[older history automatically compacted in memory; original session file is unchanged]";
  switch (entry?.type) {
    case "message":
      if (!entry.message) return entry;
      return { ...entry, message: { ...entry.message, content: entry.message.role === "system" ? marker : [{ type: "text", text: marker }], details: undefined } };
    case "compaction":
      return { ...entry, summary: marker, systemMessage: undefined, details: undefined };
    case "branch_summary":
      return { ...entry, summary: marker, details: undefined };
    case "custom_message":
      return { ...entry, content: marker, details: undefined };
    case "context_edit":
      return { ...entry, replacement: null };
    default:
      return entry;
  }
}
function assertUnchanged(before, after) {
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== after.ino || before.dev !== after.dev) {
    throw refusal("Session changed while its memory-safe copy was being prepared; retry the operation", "SESSION_CHANGED_DURING_SLIM", 409);
  }
}
/** SDK 1.0.0-specific fail-closed guards. Never persist a memory-only projection as full history. */
function protectSlimManager(manager, sourceFile, omittedIds) {
  if (typeof manager.getSessionFile === "function" && (typeof manager._rewriteFile !== "function" || typeof manager.getBranch !== "function" || manager.flushed !== true)) {
    throw refusal("Unsupported SDK session persistence layout; safe projection cannot be attached", "SESSION_SDK_UNSUPPORTED", 503);
  }
  const unsupported = () => { throw refusal("This operation needs full history; reopen an unslimmed session before branching or rewriting", "SESSION_FULL_HISTORY_REQUIRED", 409); };
  if (typeof manager._rewriteFile === "function") {
    const rewrite = manager._rewriteFile;
    manager._rewriteFile = function (...args) {
      if (resolve(this.sessionFile ?? "") === sourceFile) return unsupported();
      return rewrite.apply(this, args);
    };
  }
  // Refuse before SDK methods change leaf, identity or fileEntries. The source remains untouched.
  for (const name of ["branch", "branchWithSummary", "createBranchedSession"]) {
    const original = manager[name];
    if (typeof original !== "function") continue;
    manager[name] = function (id, ...args) {
      const path = typeof this.getBranch === "function" ? this.getBranch(id ?? undefined) : [];
      if (path.some((entry) => omittedIds.has(entry.id))) return unsupported();
      return original.call(this, id, ...args);
    };
  }
  // The SDK's setSessionFile bypasses Host admission checks: large reloads must use this loader.
  if (typeof manager.setSessionFile === "function") {
    const set = manager.setSessionFile;
    manager.setSessionFile = function (file) {
      assertSessionLoadAllowed(file);
      return set.call(this, file);
    };
  }
}
/** Large history is projected only in memory. Escalate compression automatically,
 * preserving source bytes, user/assistant messages in context and active images. */
export function openSessionManagerSafely(sourceFile, openSession, {
  readMemory = readRuntimeMemory, stat = statSync, tempRoot = tmpdir(), write = writeSync,
} = {}) {
  sourceFile = resolve(sourceFile);
  const before = stat(sourceFile, { bigint: true });
  if (before.size <= BigInt(MAX_SESSION_LOAD_BYTES)) {
    assertMemoryHeadroom(Number(before.size), readMemory());
    return openSession(sourceFile, dirname(sourceFile));
  }
  assertMemoryHeadroom(MAX_SESSION_LINE_BYTES, readMemory()); // Fail before scanning under pressure.
  // Unlike SDK.open(source), opening the copy cannot repair the source's missing delimiter.
  // Never allow a later append to concatenate two JSON entries in the untouched source.
  const sourceFd = openSync(sourceFile, "r");
  try {
    const lastByte = Buffer.alloc(1);
    if (readSync(sourceFd, lastByte, 0, 1, fstatSync(sourceFd).size - 1) !== 1 || lastByte[0] !== 10) {
      throw refusal("Session is missing its final newline; repair the delimiter before reopening", "SESSION_FINAL_NEWLINE_REQUIRED", 409);
    }
  } finally { closeSync(sourceFd); }
  const { activeIds, retained } = selectActiveEntries(sourceFile);
  const directory = mkdtempSync(join(tempRoot, "leafcode-session-slim-"));
  const slimFile = join(directory, "session.jsonl");
  const omittedIds = new Set();
  let fd;
  let loadedBytes = 0;
  try {
    let compressionLevel = 0;
    for (; compressionLevel <= 2; compressionLevel += 1) {
      omittedIds.clear();
      loadedBytes = 0;
      fd = openSync(slimFile, compressionLevel === 0 ? "wx" : "w", 0o600);
      try {
        scanJsonl(sourceFile, (entry) => {
          const active = activeIds.has(entry.id);
          const sanitized = compressionLevel > 0 && !active
            ? compactInactiveEntry(entry)
            : slimToolResult(entry, active, compressionLevel === 2);
          if (sanitized !== entry) omittedIds.add(entry.id);
          const bytes = Buffer.from(`${JSON.stringify(sanitized)}\n`);
          loadedBytes += bytes.length;
          if (loadedBytes > MAX_SESSION_LOAD_BYTES) throw refusal("Session exceeds the safe load limit even after automatic compression; original file is unchanged", "SESSION_SLIM_TOO_LARGE");
          let offset = 0;
          while (offset < bytes.length) {
            const written = write(fd, bytes, offset, bytes.length - offset);
            if (!Number.isInteger(written) || written <= 0) throw refusal("Incomplete session projection write", "SESSION_SLIM_WRITE_FAILED", 500);
            offset += written;
          }
        });
      } catch (error) {
        if (error.code !== "SESSION_SLIM_TOO_LARGE" || compressionLevel === 2) throw error;
        assertUnchanged(before, stat(sourceFile, { bigint: true }));
        assertMemoryHeadroom(MAX_SESSION_LINE_BYTES, readMemory());
        continue;
      } finally {
        closeSync(fd);
        fd = undefined;
      }
      break;
    }
    assertUnchanged(before, stat(sourceFile, { bigint: true }));
    assertMemoryHeadroom(loadedBytes, readMemory());
    const manager = openSession(slimFile, dirname(sourceFile));
    assertUnchanged(before, stat(sourceFile, { bigint: true }));
    protectSlimManager(manager, sourceFile, omittedIds);
    manager.sessionFile = sourceFile;
    manager.memorySlimmed = true;
    manager.memorySlimStats = { sourceBytes: Number(before.size), retainedImageChars: retained, loadedBytes, compressionLevel };
    return manager;
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
export function assertSessionLoadAllowed(file, { readMemory = readRuntimeMemory, stat = statSync } = {}) {
  const bytes = file ? stat(file).size : 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SESSION_LOAD_BYTES) throw refusal("Session history exceeds the direct-read limit; open it through the memory-safe session loader", "SESSION_FILE_TOO_LARGE");
  assertMemoryHeadroom(bytes, readMemory());
}

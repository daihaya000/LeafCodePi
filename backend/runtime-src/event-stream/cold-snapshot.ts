import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { offlineDetailFlags } from "@backend-core/task-detail.mjs";
import { resumeReservationFromBranch, RESUME_ENTRY_TYPE } from "@shared/session-resume";
import { getTask } from "../lib/store";
import { isTaskRuntimeOwnedElsewhere } from "../lib/pi/harness";
import { readGoalLoopState } from "../lib/pi/goal-loop-state";
import { projectPiMessages, piRawMessageProjectsToUi, isGoalLoopTurnMarker, isAgentSwitchMarker, isIntercomMessageMarker } from "../lib/pi/messages";
import { todosFromPiMessages } from "../lib/pi/todowrite-state";
import { applySnapshotThroughput } from "../lib/pi/snapshot-messages";
import { THROUGHPUT_CUSTOM_TYPE, restoreThroughputFromEntries } from "../lib/token-throughput";
import { markColdMessageWindow } from "../lib/task-history";
import { readHistoryPageSize } from "../lib/pi/history-page-size";
import { validateBoundedEvent } from "./bounded-writer";
import type { TaskDetail, UiMessage } from "../lib/types";
const MIB = 1024 * 1024, LINE = 2 * MIB, FILE = 512 * MIB, INDEX = 8 * MIB, PAGE = 4 * MIB;
const stats = { coldReaders: 0, coldWaiters: 0, coldDescriptors: 0, coldScanBytes: 0, coldBufferBytes: 0 };
type Row = { id: string; parent: string | null; offset: number; length: number; raw: boolean; visible: boolean; user: boolean; marker?: string; todo: boolean; resume: boolean; compaction: boolean; kept?: string; timing?: number };
type Index = { version: string; sessionId: string; leaf: string | null; rows: Map<string, Row>; bytes: number };
const cache = new Map<string, Index>(); let cachedBytes = 0, buffer: Buffer | undefined;
const decoder = new TextDecoder("utf-8", { fatal: true });
export const readColdSnapshotDiagnostics = () => ({ ...stats, coldIndexBytes: cachedBytes, coldIndexEntries: cache.size });
const refuse = (status: number) => Object.assign(new Error("履歴が読み込み制限を超えたか、読み込み中に変更された。履歴を読み込まずに再接続できる（保存済みの履歴は削除されない）。"), { status, code: "COLD_TRANSCRIPT_UNAVAILABLE" });
const waiters: Array<() => void> = [];
async function admit(signal: AbortSignal) {
  signal.throwIfAborted();
  if (stats.coldWaiters >= 32) throw refuse(503);
  if (stats.coldReaders) await new Promise<void>((resolve, reject) => {
    stats.coldWaiters++;
    const abort = () => { const i = waiters.indexOf(wake); if (i >= 0) { waiters.splice(i, 1); stats.coldWaiters--; reject(signal.reason); } };
    const wake = () => { signal.removeEventListener("abort", abort); stats.coldWaiters--; resolve(); };
    waiters.push(wake); signal.addEventListener("abort", abort, { once: true });
  }); else stats.coldReaders++;
  return () => { const next = waiters.shift(); if (next) next(); else stats.coldReaders--; };
}
function rawEntry(e: any): any {
  if (e.type === "message") return e.message;
  if (e.type === "compaction") return { id: e.id, role: "compactionSummary", timestamp: Date.parse(e.timestamp) || 0, summary: e.summary, tokensBefore: e.tokensBefore };
  if (e.type !== "custom_message") return null;
  const raw = { id: e.id, role: "custom", timestamp: Date.parse(e.timestamp) || 0, customType: e.customType, content: e.content, display: e.display, details: e.details };
  return piRawMessageProjectsToUi(raw) || isGoalLoopTurnMarker(raw) || isAgentSwitchMarker(raw) || isIntercomMessageMarker(raw) ? raw : null;
}
// Parsed substring identifiers must not keep an arbitrarily large source line alive.
// UTF-16 round-trip preserves every code unit (including lone surrogates) and owns
// only the bounded identifier, unlike slice/substring/String which may share backing.
const ownId = (value: string) => Buffer.from(value, "utf16le").toString("utf16le");
function metadata(e: any, offset: number, length: number): Row | null {
  if (!e || e.type === "session") return null;
  if (typeof e.id !== "string" || !e.id || e.id.length > 512 || e.parentId !== null && (typeof e.parentId !== "string" || e.parentId.length > 512)) throw refuse(409);
  if (typeof e.firstKeptEntryId === "string" && e.firstKeptEntryId.length > 512) throw refuse(413);
  const raw = rawEntry(e), marker = raw && (isAgentSwitchMarker(raw) ? "agent" : isGoalLoopTurnMarker(raw) ? "goal" : isIntercomMessageMarker(raw) ? "intercom" : undefined);
  return { id: ownId(e.id), parent: e.parentId === null ? null : ownId(e.parentId), offset, length, raw: Boolean(raw), visible: Boolean(raw && piRawMessageProjectsToUi(raw)), user: raw?.role === "user" || Boolean(raw && isGoalLoopTurnMarker(raw) && piRawMessageProjectsToUi(raw)), marker,
    todo: raw?.role === "toolResult" && raw.toolName === "todowrite", resume: e.type === "custom" && e.customType === RESUME_ENTRY_TYPE,
    compaction: e.type === "compaction", kept: typeof e.firstKeptEntryId === "string" ? ownId(e.firstKeptEntryId) : undefined,
    timing: e.type === "custom" && e.customType === THROUGHPUT_CUSTOM_TYPE && typeof e.data?.startedAtMs === "number" ? e.data.startedAtMs : undefined };
}
function forget(path: string) { const old = cache.get(path); if (old) { cachedBytes -= old.bytes; cache.delete(path); } }
function remember(path: string, index: Index) {
  forget(path); while (cache.size >= 4 || cachedBytes + index.bytes > INDEX) forget(cache.keys().next().value!);
  cache.set(path, index); cachedBytes += index.bytes;
}
async function readWindow(path: string, signal: AbortSignal, includeMessages: boolean) {
  const release = await admit(signal); let fd: FileHandle | undefined;
  try {
    if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw refuse(403);
    fd = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)); stats.coldDescriptors++;
    const before = await fd.stat({ bigint: true }), named = await stat(path, { bigint: true });
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino || await realpath(path) !== resolve(path)) throw refuse(403);
    if (before.size > BigInt(FILE)) throw refuse(413);
    const version = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
    const until = Date.now() + 8000, check = () => { signal.throwIfAborted(); if (Date.now() > until) throw refuse(503); };
    if (!buffer) { buffer = Buffer.allocUnsafe(LINE); stats.coldBufferBytes = LINE; }
    let index = cache.get(path);
    if (index?.version !== version(before)) {
      forget(path); index = { version: version(before), sessionId: "", leaf: null, rows: new Map(), bytes: 0 };
      const scratch = Buffer.allocUnsafe(65536); let used = 0, offset = 0, header = false;
      const emit = (end: number) => {
        const length = used; used = 0; if (!length) return;
        let text: string;
        try { text = decoder.decode(buffer!.subarray(0, length)); } catch { throw refuse(409); }
        let e: any; try { e = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
        if (!header) { if (e?.type !== "session" || e.version !== 3 || typeof e.id !== "string" || e.id.length > 512) throw refuse(409); index!.sessionId = ownId(e.id); header = true; return; }
        if (e?.type === "session") throw refuse(409);
        const row = metadata(e, end - length, length); if (!row) return;
        if (index!.rows.has(row.id)) throw refuse(409);
        index!.bytes += 320 + 2 * (row.id.length + (row.parent?.length ?? 0) + (row.kept?.length ?? 0));
        if (index!.bytes > INDEX || index!.rows.size >= 100000) throw refuse(413);
        index!.rows.set(row.id, row); index!.leaf = row.id;
      };
      for (;;) {
        check(); const part = await fd.read(scratch, 0, scratch.length, offset); if (!part.bytesRead) break;
        stats.coldScanBytes += part.bytesRead;
        for (let start = 0; start < part.bytesRead;) {
          const nl = scratch.indexOf(10, start), end = nl >= 0 && nl < part.bytesRead ? nl : part.bytesRead, length = end - start;
          if (used + length > LINE) throw refuse(413); scratch.copy(buffer, used, start, end); used += length;
          if (nl >= 0 && nl < part.bytesRead) { emit(offset + end); start = end + 1; } else start = part.bytesRead;
        }
        offset += part.bytesRead;
      }
      emit(offset); if (!header) throw refuse(409);
    }
    const branch: Row[] = [], seen = new Set<string>();
    for (let id = index.leaf; id;) { if (seen.has(id)) throw refuse(409); seen.add(id); const row = index.rows.get(id); if (!row) throw refuse(409); branch.push(row); id = row.parent; }
    branch.reverse();
    let start = branch.length, visible = 0;
    if (includeMessages) {
      for (let i = branch.length - 1; i >= 0; i--) if (branch[i].visible && ++visible >= readHistoryPageSize()) { start = i; break; }
      if (visible < readHistoryPageSize()) start = 0;
      if (start > 0 && !branch[start].user) { for (let i = start - 1; i >= 0; i--) if (branch[i].user) { start = i; break; } }
    }
    const hasMore = branch.some((r, i) => i < start && r.visible), selected = new Set<Row>(), markers = new Map<string, Row>();
    for (let i = 0; i < start; i++) { const row = branch[i]; if (row.marker) markers.set(row.marker, row); if (row.user) { markers.delete("goal"); markers.delete("intercom"); } }
    const markerRows = new Set(markers.values());
    if (includeMessages) { for (const r of markerRows) selected.add(r); for (let i = start; i < branch.length; i++) if (branch[i].raw) selected.add(branch[i]); }
    const compaction = branch.findLastIndex(r => r.compaction), kept = compaction >= 0 ? branch.findIndex(r => r.id === branch[compaction].kept) : 0;
    const contextStart = compaction < 0 ? 0 : kept < 0 ? compaction : kept;
    const todo = branch.findLast((r, i) => r.todo && i >= contextStart), resume = branch.findLast(r => r.resume);
    if (todo) selected.add(todo); if (resume) selected.add(resume);
    const entries = new Map<Row, any>(); let bytes = 0;
    const read = async (row: Row) => {
      check(); bytes += row.length; if (bytes > PAGE) throw refuse(413);
      const part = await fd!.read(buffer!, 0, row.length, row.offset); if (part.bytesRead !== row.length) throw refuse(409);
      return JSON.parse(decoder.decode(buffer!.subarray(0, row.length)));
    };
    for (const row of selected) entries.set(row, await read(row));
    const raw: any[] = [], ids: string[] = [], timestamps = new Set<number>(); let ordinal = 0;
    for (let i = 0; i < branch.length; i++) {
      const row = branch[i]; if (!row.raw) continue;
      if (includeMessages && (i >= start || markerRows.has(row))) {
        const message = rawEntry(entries.get(row)); const item = { ...message, id: message.id || `msg-${ordinal}` }; raw.push(item);
        if (row.visible) ids.push(row.id); if (typeof item.timestamp === "number") timestamps.add(item.timestamp);
      }
      ordinal++;
    }
    const timings: any[] = [];
    // Persisted throughput, like the SDK, may reside outside the selected branch. Only
    // samples for the bounded page are restored; no full getEntries/model context allocation.
    if (includeMessages) for (const row of index.rows.values()) if (row.timing !== undefined && timestamps.has(row.timing)) timings.push(await read(row));
    let messages: UiMessage[] = includeMessages ? projectPiMessages(raw) : [];
    messages = messages.map((m, i) => ({ ...m, id: ids[i] ?? m.id }));
    if (timings.length) messages = applySnapshotThroughput(messages, restoreThroughputFromEntries(timings).timings);
    try { validateBoundedEvent(messages, PAGE); } catch { throw refuse(413); }
    const after = await fd.stat({ bigint: true }), current = await stat(path, { bigint: true });
    if (version(after) !== version(before) || version(current) !== version(before) || await realpath(path) !== resolve(path)) throw refuse(409);
    check(); if (cache.get(path) !== index) remember(path, index);
    else { cache.delete(path); cache.set(path, index); }
    const reservation = resume && resumeReservationFromBranch([entries.get(resume)], index.sessionId);
    markColdMessageWindow(messages, hasMore);
    return { messages, todos: todo ? todosFromPiMessages([rawEntry(entries.get(todo))]) : [], sessionResume: reservation?.status === "scheduled" ? { id: reservation.id, at: reservation.at, message: reservation.message } : null, messageRevision: `offline:${index.version}` };
  } catch (error) { forget(path); throw error; }
  finally { try { if (fd) { try { await fd.close(); } finally { stats.coldDescriptors--; } } } finally { release(); } }
}
/** Null selects the existing owned live snapshot; all other reads bypass SDK.open/repair/cache. */
export async function readColdIndividualDetail(id: string, options: { offline?: boolean; includeMessages?: boolean; omitTranscript?: boolean }, signal: AbortSignal): Promise<TaskDetail | null> {
  assertConfigurationOwner(); signal.throwIfAborted(); const task = getTask(id); if (!task) return null;
  const live = (globalThis as any).__leafcodePiHarness?.live?.get(id);
  if (task.status !== "archived" && !options.offline && !isTaskRuntimeOwnedElsewhere(task) && live && !live.leaseLost) return null;
  let parts: Omit<Awaited<ReturnType<typeof readWindow>>, "messageRevision"> & { messageRevision?: string } = { messages: [], todos: [], sessionResume: null };
  if (task.sessionFile && !options.omitTranscript) { try { parts = await readWindow(task.sessionFile, signal, options.includeMessages !== false); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; } }
  // Pair transcript fields with the task row captured before async IO. Re-reading
  // bootstrap here could label old-file messages with a newly switched session.
  return { ...task, ...parts, ...offlineDetailFlags(task), isStreaming: task.status === "working", permissionRequest: null, questionRequest: null,
    goalLoop: task.status === "archived" ? null : readGoalLoopState(task.directory, task.sessionId), sessionResume: task.status === "archived" ? null : parts.sessionResume };
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { MAX_SESSION_LOAD_BYTES } from "@backend-core/session-memory-guard.mjs";
import { insertTask, patchTask, upsertProject } from "@/lib/store";
import { getTaskDetail, getTaskDetailReadOnly, readTaskProgressSnapshot, relieveRuntimeMemoryPressure, resetOfflineSessionSnapshotsForTests } from "./harness";

vi.mock("node:v8", () => ({ getHeapStatistics: () => ({ heap_size_limit: 4096 * 1024 * 1024 }) }));
const globals = globalThis as Record<PropertyKey, unknown>;
const key = "__leafcodePiHarness";
const registryKey = Symbol.for("pi-subagents.background-work.v1");
const previous = globals[key];
const previousRegistry = globals[registryKey];
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const dirs: string[] = [];
const MIB = 1024 * 1024;

function memory(heapUsed = 100 * MIB) {
  vi.spyOn(process, "memoryUsage").mockReturnValue({ heapUsed, heapTotal: heapUsed, rss: heapUsed, external: 0, arrayBuffers: 0 });
}
function fixture() {
  memory();
  const root = mkdtempSync(join(tmpdir(), "harness-memory-"));
  dirs.push(root);
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
  const project = upsertProject({ rootPath: root, name: "memory" });
  const task = insertTask({ project, title: "test" });
  const open = vi.fn(() => ({ buildSessionContext: () => ({ messages: [] }) }));
  const live = new Map<string, ReturnType<typeof idleLive>>();
  const events = new EventEmitter();
  globals[key] = { pi: { SessionManager: { open } }, live, events };
  globals[registryKey] = { version: 1, providers: new Map() };
  return { root, project, task, open, live, events };
}
function idleLive(root: string, taskId: string, now: number) {
  return {
    taskId, accountId: null, lastActivityAt: now - 120_000, promptActive: false,
    session: {
      sessionId: `session-${taskId}`, sessionFile: join(root, `${taskId}.jsonl`),
      isStreaming: false, isCompacting: false,
      sessionManager: { getCwd: () => root },
      extensionRunner: { hasHandlers: () => true, emit: vi.fn(async () => {}) },
      dispose: vi.fn(),
    },
    unsubscribe: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetOfflineSessionSnapshotsForTests();
  if (previous === undefined) delete globals[key]; else globals[key] = previous;
  if (previousRegistry === undefined) delete globals[registryKey]; else globals[registryKey] = previousRegistry;
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR; else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session memory protection", () => {
  it("rejects a huge history before SDK open, in cold read and live attach paths, without rewriting it", async () => {
    const { root, task, open } = fixture();
    const file = join(root, "huge.jsonl");
    const fd = openSync(file, "w");
    try { ftruncateSync(fd, MAX_SESSION_LOAD_BYTES + 1); } finally { closeSync(fd); }
    patchTask(task.id, { sessionFile: file });
    await assert.rejects(readTaskProgressSnapshot(task.id), { status: 413, code: "SESSION_FILE_TOO_LARGE" });
    await assert.rejects(getTaskDetailReadOnly(task.id), { status: 413 });
    await assert.rejects(getTaskDetail(task.id), { status: 413 });
    assert.equal(open.mock.calls.length, 0);
    assert.equal(statSync(file).size, MAX_SESSION_LOAD_BYTES + 1);
  });

  it("refuses new cold allocations under pressure but keeps already cached history available", async () => {
    const { root, task, open } = fixture();
    const file = join(root, "small.jsonl");
    writeFileSync(file, "{}\n");
    patchTask(task.id, { sessionFile: file });
    await readTaskProgressSnapshot(task.id);
    memory(3200 * MIB);
    await readTaskProgressSnapshot(task.id);
    assert.equal(open.mock.calls.length, 1);
    writeFileSync(file, "{}\n{}\n");
    await assert.rejects(readTaskProgressSnapshot(task.id), { status: 503, code: "SESSION_MEMORY_PRESSURE" });
    assert.equal(open.mock.calls.length, 1);
  });

  it("reclaims only abandoned idle sessions under pressure and clears reconstructible snapshots", async () => {
    const { root, task, project, open, live, events } = fixture();
    const now = Date.now();
    const file = join(root, "snapshot.jsonl");
    writeFileSync(file, "{}\n");
    patchTask(task.id, { sessionFile: file });
    await readTaskProgressSnapshot(task.id);
    const rows = ["idle", "recent", "streaming", "compacting", "prompting", "watched", "background", "loop"].map((title) => insertTask({ project, title }));
    const entries = rows.map((row) => idleLive(root, row.id, now));
    entries.forEach((entry) => live.set(entry.taskId, entry));
    entries[1].lastActivityAt = now - 1000;
    entries[2].session.isStreaming = true;
    entries[3].session.isCompacting = true;
    entries[4].promptActive = true;
    events.on(entries[5].taskId, () => {});
    globals[registryKey] = { version: 1, providers: new Map([["subagents", { name: "subagents", listActiveWork: () => [{ id: "work", sessionId: entries[6].session.sessionFile }] }]]) };
    const loopDir = join(root, "data", "goals-loop");
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, `${entries[7].session.sessionId}.json`), JSON.stringify({ goal: "continue", status: "queued" }));
    assert.deepEqual(await relieveRuntimeMemoryPressure(now), []);
    await readTaskProgressSnapshot(task.id);
    assert.equal(open.mock.calls.length, 1, "normal memory does not flush caches");
    memory(3200 * MIB);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assert.deepEqual(await relieveRuntimeMemoryPressure(now), [entries[0].taskId]);
    assert.equal(entries[0].session.extensionRunner.emit.mock.calls.length, 1);
    assert.equal(entries[0].session.dispose.mock.calls.length, 1);
    for (const entry of entries.slice(1)) {
      assert.equal(live.has(entry.taskId), true);
      assert.equal(entry.session.dispose.mock.calls.length, 0);
    }
    assert.equal(warn.mock.calls.length, 1);
    const counters = JSON.parse(String(warn.mock.calls[0][1]));
    assert.equal(counters.heapUsed, 3200 * MIB);
    assert.ok(Object.values(counters).every((value) => typeof value === "number"));
    await relieveRuntimeMemoryPressure(now + 1);
    assert.equal(warn.mock.calls.length, 1, "pressure logs are rate limited");
    memory();
    await readTaskProgressSnapshot(task.id);
    assert.equal(open.mock.calls.length, 2, "pressure clears cached projections");
  });
});

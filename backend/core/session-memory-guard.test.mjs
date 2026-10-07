import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, openSync, ftruncateSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSessionLoadAllowed, isRuntimeMemoryPressure, MAX_SESSION_LOAD_BYTES, readRuntimeMemory } from "./session-memory-guard.mjs";

const MIB = 1024 * 1024;
const readMemory = () => ({ heapUsed: 1024 * MIB, heapLimit: 4096 * MIB });

test("allows small history and new sessions with sufficient headroom", () => {
  assertSessionLoadAllowed("small", { stat: () => ({ size: 20 * MIB }), readMemory });
  assertSessionLoadAllowed(null, { stat: () => { throw new Error("must not stat"); }, readMemory });
  assertSessionLoadAllowed("boundary", { stat: () => ({ size: MAX_SESSION_LOAD_BYTES }), readMemory });
});

test("rejects oversized histories before reading memory or materializing contents", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-memory-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "large.jsonl");
  const fd = openSync(file, "w");
  try { ftruncateSync(fd, MAX_SESSION_LOAD_BYTES + 1); } finally { closeSync(fd); }
  assert.throws(() => assertSessionLoadAllowed(file, {
    readMemory: () => { throw new Error("must reject before memory sampling"); },
  }), { status: 413, code: "SESSION_FILE_TOO_LARGE" });
  assert.equal(statSync(file).size, MAX_SESSION_LOAD_BYTES + 1, "history stays untouched");
});

test("reserves headroom for parsing as well as a quarter of the heap", () => {
  const memory = () => ({ heapUsed: 2800 * MIB, heapLimit: 4096 * MIB });
  assert.equal(isRuntimeMemoryPressure(memory()), false);
  assert.throws(() => assertSessionLoadAllowed("large", {
    stat: () => ({ size: MAX_SESSION_LOAD_BYTES }), readMemory: memory,
  }), { status: 503, code: "SESSION_MEMORY_PRESSURE" });
  assertSessionLoadAllowed("small", { stat: () => ({ size: MIB }), readMemory: memory });
});

test("rejects even new sessions at the pressure boundary; low heap limits keep a minimum reserve", () => {
  assert.throws(() => assertSessionLoadAllowed(null, {
    readMemory: () => ({ heapUsed: 3072 * MIB, heapLimit: 4096 * MIB }),
  }), { status: 503 });
  assert.equal(isRuntimeMemoryPressure({ heapUsed: 512 * MIB, heapLimit: 1024 * MIB }), true);
  assert.equal(isRuntimeMemoryPressure({ heapUsed: 511 * MIB, heapLimit: 1024 * MIB }), false);
});

test("stat failures propagate without opening a file and runtime metrics contain only numbers", () => {
  assert.throws(() => assertSessionLoadAllowed("missing", {
    stat: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, readMemory,
  }), { code: "ENOENT" });
  for (const value of Object.values(readRuntimeMemory())) assert.ok(Number.isFinite(value) && value >= 0);
});

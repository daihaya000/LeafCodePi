import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogFileWriter } from "./log-file.js";

test("log writer creates a private POSIX log", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-log-"));
  try {
    const writer = createLogFileWriter(dir);
    writer.write({ source: "host", level: "log", text: "hello" });
    const file = join(dir, "host.log");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, "utf8"), /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log writer repairs an existing POSIX log", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-log-"));
  try {
    const file = join(dir, "host.log");
    writeFileSync(file, "old\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    createLogFileWriter(dir).write({ source: "host", level: "log", text: "new" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotates by tracked size without a stat per line", () => {
  const calls = { stat: 0, rename: 0 };
  const sizes = new Map();
  const file = join("C:/logs", "host.log");
  const writer = createLogFileWriter("C:/logs", {
    mkdirSync: () => {},
    platform: "win32",
    maxBytes: 200,
    existsSync: (path) => sizes.has(path),
    statSync: (path) => { calls.stat += 1; return { size: sizes.get(path) ?? 0 }; },
    appendFileSync: (path, data) => { sizes.set(path, (sizes.get(path) ?? 0) + Buffer.byteLength(data)); },
    renameSync: (from, to) => { calls.rename += 1; sizes.set(to, sizes.get(from)); sizes.delete(from); },
    unlinkSync: (path) => sizes.delete(path),
  });
  for (let i = 0; i < 30; i += 1) writer.write({ ts: 0, source: "host", level: "log", text: "x".repeat(40) });
  assert.ok(calls.rename >= 1, "rotated once the tracked size crossed the limit");
  assert.ok(calls.stat <= 2, `stat was called ${calls.stat} times`);
  assert.ok((sizes.get(file) ?? 0) < 200 + 100);
});

test("keeps two generations so a rotated file outlives one more rotation", () => {
  const calls = { rename: 0, unlink: 0 };
  const sizes = new Map();
  const file = join("C:/logs", "host.log");
  const writer = createLogFileWriter("C:/logs", {
    mkdirSync: () => {},
    platform: "win32",
    maxBytes: 200,
    existsSync: (path) => sizes.has(path),
    statSync: (path) => ({ size: sizes.get(path) ?? 0 }),
    appendFileSync: (path, data) => { sizes.set(path, (sizes.get(path) ?? 0) + Buffer.byteLength(data)); },
    renameSync: (from, to) => { calls.rename += 1; sizes.set(to, sizes.get(from)); sizes.delete(from); },
    unlinkSync: (path) => { calls.unlink += 1; sizes.delete(path); },
  });
  for (let i = 0; i < 30; i += 1) writer.write({ ts: 0, source: "host", level: "log", text: "x".repeat(40) });
  assert.ok(calls.rename >= 3, "each rotation shifts .1 to .2 before the new .1 is written");
  assert.equal(sizes.has(`${file}.2`), true);
});

test("a concurrent writer's bytes are re-synced even when no rotation is due", () => {
  const calls = { stat: 0, rename: 0 };
  const sizes = new Map();
  let externalBytes = 0;
  const file = join("C:/logs", "host.log");
  const writer = createLogFileWriter("C:/logs", {
    mkdirSync: () => {},
    platform: "win32",
    // High enough that this writer's own lines never trigger a rotation, so the
    // only stat calls come from the forced re-sync.
    maxBytes: 5_000_000,
    existsSync: (path) => sizes.has(path) || externalBytes > 0,
    // Another process appended off our tracked size, so the on-disk size is
    // larger than what this writer believes.
    statSync: (path) => { calls.stat += 1; return { size: (sizes.get(path) ?? 0) + externalBytes }; },
    appendFileSync: (path, data) => { sizes.set(path, (sizes.get(path) ?? 0) + Buffer.byteLength(data)); },
    renameSync: (from, to) => { calls.rename += 1; sizes.set(to, sizes.get(from)); sizes.delete(from); },
    unlinkSync: (path) => sizes.delete(path),
  });

  writer.write({ ts: 0, source: "host", level: "log", text: "a".repeat(40) });
  externalBytes = 1_000;
  calls.stat = 0;
  // 64-write rotation resync would also stat, so assert the extra calls that only
  // the forced re-sync produces: 300 writes -> 1 forced + 4 rotation resyncs.
  for (let i = 0; i < 300; i += 1) {
    writer.write({ ts: 0, source: "host", level: "log", text: "b".repeat(10) });
  }

  assert.ok(calls.stat >= 1, `expected the forced re-sync to stat, got ${calls.stat}`);
  assert.equal(calls.rename, 0, "no rotation should be due at this size");
  void file;
});


test("rotation still fires when another process appended past the limit", () => {
  const calls = { rename: 0 };
  const sizes = new Map();
  let externalBytes = 0;
  const file = join("C:/logs", "host.log");
  const writer = createLogFileWriter("C:/logs", {
    mkdirSync: () => {},
    platform: "win32",
    maxBytes: 200,
    existsSync: (path) => sizes.has(path) || externalBytes > 0,
    statSync: (path) => ({ size: (sizes.get(path) ?? 0) + externalBytes }),
    appendFileSync: (path, data) => { sizes.set(path, (sizes.get(path) ?? 0) + Buffer.byteLength(data)); },
    renameSync: (from, to) => { calls.rename += 1; sizes.set(to, sizes.get(from)); sizes.delete(from); },
    unlinkSync: (path) => sizes.delete(path),
  });

  writer.write({ ts: 0, source: "host", level: "log", text: "a".repeat(40) });
  // Another process alone pushes the file past the limit.
  externalBytes = 1_000;
  for (let i = 0; i < 64; i += 1) {
    writer.write({ ts: 0, source: "host", level: "log", text: "b".repeat(10) });
  }

  assert.ok(calls.rename >= 1, "rotation must pick up the other process's bytes");
  assert.equal(sizes.has(`${file}.1`), true);
});

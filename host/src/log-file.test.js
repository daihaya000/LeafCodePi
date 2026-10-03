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

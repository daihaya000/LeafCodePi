import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "./file-lock.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-file-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { file: join(root, "store.json"), lock: join(root, "store.json.lock") };
}
test("lock returns values and releases after failures", (t) => {
  const { file, lock } = fixture(t);
  assert.equal(withFileLock(file, () => 42), 42);
  assert.throws(() => withFileLock(file, () => { throw new Error("failed"); }), /failed/);
  assert.equal(existsSync(lock), false);
});
test("an old lock belonging to a live owner is never stolen", (t) => {
  const { file, lock } = fixture(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${process.pid}:live`);
  utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => withFileLock(file, () => assert.fail("stolen"), { timeoutMs: 30 }), /timeout/);
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), `${process.pid}:live`);
});
test("a dead owner is reclaimed without waiting for a time-based expiry", (t) => {
  const { file, lock } = fixture(t);
  const pid = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${pid}:dead`);
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
  assert.equal(existsSync(lock), false);
});
test("an incomplete fresh owner blocks but an abandoned creation can recover", (t) => {
  const { file, lock } = fixture(t);
  mkdirSync(lock);
  assert.throws(() => withFileLock(file, () => assert.fail("stolen"), { timeoutMs: 30 }), /timeout/);
  utimesSync(lock, new Date(0), new Date(0));
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
});

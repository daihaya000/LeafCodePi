import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
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
test("a live owner lock younger than the hard cap is not stolen", (t) => {
  const { file, lock } = fixture(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${process.pid}:live`);
  const recent = new Date(Date.now() - 60_000);
  utimesSync(lock, recent, recent);
  assert.throws(() => withFileLock(file, () => assert.fail("stolen"), { timeoutMs: 30 }), /timeout/);
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), `${process.pid}:live`);
});
test("a live PID lock older than the hard cap is reclaimed", (t) => {
  const { file, lock } = fixture(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${process.pid}:reused`);
  const expired = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, expired, expired);
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
  assert.equal(existsSync(lock), false);
});
test("a dead owner is reclaimed without waiting for a time-based expiry", (t) => {
  const { file, lock } = fixture(t);
  const pid = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${pid}:dead`);
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
  assert.equal(existsSync(lock), false);
});
test("a stale reclaim marker can recover while all contenders share the OS mutex", (t) => {
  const { file, lock } = fixture(t);
  const pid = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
  for (const path of [lock, `${lock}.reclaim`]) {
    mkdirSync(path); writeFileSync(join(path, "owner"), `${pid}:dead`);
  }
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
  assert.equal(existsSync(`${lock}.reclaim`), false);
});
test("an OS mutex blocks even when no directory owner exists", (t) => {
  const { file, lock } = fixture(t);
  const mutex = new DatabaseSync(`${file}.lock.sqlite`);
  try {
    mutex.exec("BEGIN IMMEDIATE");
    assert.throws(() => withFileLock(file, () => assert.fail("concurrent writer"), { timeoutMs: 30 }), /timeout/);
    assert.equal(existsSync(lock), false);
  } finally { mutex.close(); }
  assert.equal(withFileLock(file, () => 42), 42);
});
test("process death releases the OS mutex and allows directory owner recovery", { timeout: 5000 }, async (t) => {
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  });
  const { file } = fixture(t);
  const code = `import { withFileLock } from ${JSON.stringify(new URL("./file-lock.mjs", import.meta.url).href)};
withFileLock(${JSON.stringify(file)}, () => { process.send('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });`;
  child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  assert.throws(() => withFileLock(file, () => assert.fail("stolen"), { timeoutMs: 30 }), /timeout/);
  const exited = once(child, "exit"); child.kill(); await exited;
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
});
test("an incomplete fresh owner blocks but an abandoned creation can recover", (t) => {
  const { file, lock } = fixture(t);
  mkdirSync(lock);
  assert.throws(() => withFileLock(file, () => assert.fail("stolen"), { timeoutMs: 30 }), /timeout/);
  utimesSync(lock, new Date(0), new Date(0));
  assert.equal(withFileLock(file, () => "recovered"), "recovered");
});

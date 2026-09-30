import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withDirectoryLock } from "./directory-lock.mjs";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-directory-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, options: { lockPath: join(root, "rooms", "a.lock"), parentDir: join(root, "rooms"), staleMs: 30_000, busyMessage: "room file is busy" } };
}

test("the action runs under the lock, the parent is created, and the lock is released afterwards", (t) => {
  const { options } = setup(t);
  const inside = withDirectoryLock(options, () => existsSync(options.lockPath));
  assert.equal(inside, true);
  assert.equal(existsSync(options.lockPath), false);
  assert.equal(existsSync(options.parentDir), true);
});

test("the action result is returned and a throwing action still releases the lock", (t) => {
  const { options } = setup(t);
  assert.equal(withDirectoryLock(options, () => 42), 42);
  assert.throws(() => withDirectoryLock(options, () => { throw new Error("action failed"); }), /action failed/);
  assert.equal(existsSync(options.lockPath), false);
});

test("a held lock is retried with the given wait and then reported busy with the caller's message", (t) => {
  const { options } = setup(t);
  mkdirSync(options.parentDir, { recursive: true });
  mkdirSync(options.lockPath);
  const sleeps = [];
  assert.throws(() => withDirectoryLock({ ...options, maxAttempts: 3, waitMs: 7, sleep: (ms) => sleeps.push(ms) }, () => "never"), /room file is busy/);
  assert.deepEqual(sleeps, [7, 7, 7]);
  assert.equal(existsSync(options.lockPath), true);
});

test("a lock released while waiting is acquired on the next attempt", (t) => {
  const { options } = setup(t);
  mkdirSync(options.parentDir, { recursive: true });
  mkdirSync(options.lockPath);
  let sleeps = 0;
  const result = withDirectoryLock({ ...options, sleep: () => { sleeps += 1; if (sleeps === 2) rmSync(options.lockPath, { recursive: true }); } }, () => "acquired");
  assert.equal(result, "acquired");
  assert.equal(sleeps, 2);
});

test("a lock older than the stale limit is removed and then taken, judged against the injected clock", (t) => {
  const { options } = setup(t);
  mkdirSync(options.parentDir, { recursive: true });
  mkdirSync(options.lockPath);
  const old = new Date(Date.now() - 60_000);
  utimesSync(options.lockPath, old, old);
  assert.equal(withDirectoryLock({ ...options, sleep: () => undefined }, () => "reclaimed"), "reclaimed");
  mkdirSync(options.lockPath);
  let probed = 0;
  assert.equal(withDirectoryLock({ ...options, now: () => { probed += 1; return Date.now() + 31_000; }, sleep: () => undefined }, () => "future clock"), "future clock");
  assert.ok(probed >= 1);
});

test("a fresh foreign lock is never stolen", (t) => {
  const { options } = setup(t);
  mkdirSync(options.parentDir, { recursive: true });
  mkdirSync(options.lockPath);
  assert.throws(() => withDirectoryLock({ ...options, maxAttempts: 2, sleep: () => undefined }, () => "stolen"), /busy/);
  assert.equal(existsSync(options.lockPath), true);
});

test("separate Node processes serialize a read-modify-write on one file without losing updates", { timeout: 25_000 }, async (t) => {
  const { root, options } = setup(t);
  const counter = join(root, "counter.txt");
  writeFileSync(counter, "0");
  const moduleUrl = new URL("./directory-lock.mjs", import.meta.url).href;
  const workers = 4;
  const perWorker = 25;
  const code = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
    const options = ${JSON.stringify({ ...options, maxAttempts: 2000 })};
    for (let n = 0; n < ${perWorker}; n += 1) {
      withDirectoryLock(options, () => {
        const value = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
        writeFileSync(${JSON.stringify(counter)}, String(value + 1));
      });
    }
  `;
  const children = Array.from({ length: workers }, () => spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" }));
  const codes = await Promise.all(children.map(async (child) => { const [exit] = await once(child, "exit"); return exit; }));
  assert.deepEqual(codes, Array(workers).fill(0));
  assert.equal(Number(readFileSync(counter, "utf8")), workers * perWorker);
  assert.equal(existsSync(options.lockPath), false);
});

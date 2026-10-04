import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withDirectoryLock, withDirectoryLockAsync } from "./directory-lock.mjs";

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

test("the async action holds the lock across awaits, serializes callers, and releases on failure", async (t) => {
  const { options } = setup(t);
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 4 }, () => withDirectoryLockAsync(
    { ...options, maxAttempts: 100, waitMs: 1 },
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    },
  )));
  assert.equal(maxActive, 1);
  assert.equal(existsSync(options.lockPath), false);
  await assert.rejects(withDirectoryLockAsync(options, async () => { throw new Error("async action failed"); }), /async action failed/);
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

function oldLockWithOwner(options, owner) {
  mkdirSync(options.parentDir, { recursive: true });
  mkdirSync(options.lockPath);
  writeFileSync(join(options.lockPath, "owner"), owner, "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(options.lockPath, old, old);
}

test("a stale-aged lock held by a live process is not stolen, but one held by a dead process is", (t) => {
  const { options } = setup(t);
  oldLockWithOwner(options, `${process.pid}:live-token`);
  assert.throws(() => withDirectoryLock({ ...options, maxAttempts: 2, sleep: () => undefined }, () => "stolen"), /busy/);
  assert.equal(readFileSync(join(options.lockPath, "owner"), "utf8"), `${process.pid}:live-token`);
  rmSync(options.lockPath, { recursive: true });
  oldLockWithOwner(options, "2147483646:dead-token");
  assert.equal(withDirectoryLock({ ...options, sleep: () => undefined }, () => "reclaimed"), "reclaimed");
});

test("worker heartbeat protects a sync lock during an event-loop stall beyond the live-owner hard cap", (t) => {
  const { options } = setup(t);
  const moduleUrl = new URL("./directory-lock.mjs", import.meta.url).href;
  const childOptions = JSON.stringify({ ...options, maxAttempts: 0, waitMs: 0 });
  const childSource = `
    import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
    const options = ${childOptions};
    try {
      withDirectoryLock({ ...options, sleep: () => {} }, () => process.stdout.write("acquired"));
    } catch (error) {
      if (error?.message !== options.busyMessage) { console.error(error); process.exitCode = 1; }
      else process.stdout.write("busy");
    }
  `;

  const result = withDirectoryLock({ ...options, heartbeatMs: 10 }, () => {
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(options.lockPath, old, old);
    // Block the owning thread; the worker thread must still renew the lock mtime.
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    const heartbeatDeadline = Date.now() + 2_000;
    let lockAgeMs = Date.now() - statSync(options.lockPath).mtimeMs;
    while (lockAgeMs >= options.staleMs && Date.now() < heartbeatDeadline) {
      Atomics.wait(waitArray, 0, 0, 20);
      lockAgeMs = Date.now() - statSync(options.lockPath).mtimeMs;
    }
    assert.ok(lockAgeMs < options.staleMs);

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "busy");
    return "held";
  });

  assert.equal(result, "held");
  assert.equal(existsSync(options.lockPath), false);
});

test("release never deletes a lock that was reclaimed by another owner (sync and async)", async (t) => {
  const { options } = setup(t);
  const takeOver = () => writeFileSync(join(options.lockPath, "owner"), "other:token", "utf8");
  withDirectoryLock(options, takeOver);
  assert.equal(readFileSync(join(options.lockPath, "owner"), "utf8"), "other:token");
  rmSync(options.lockPath, { recursive: true });
  await withDirectoryLockAsync(options, async () => takeOver());
  assert.equal(readFileSync(join(options.lockPath, "owner"), "utf8"), "other:token");
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

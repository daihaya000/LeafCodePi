import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createTaskLeaseState, RECLAIM_LOCK_STALE_MS, TaskLeaseService } from "./task-runtime-lease.mjs";

const deadLease = (extra = {}) => ({ token: "dead-owner", pid: 999999, acquiredAt: 1, heartbeatAt: 1, ...extra });

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-lease-reclaim-"));
  const state = createTaskLeaseState();
  const service = new TaskLeaseService({
    dataDir: () => root, listTasks: () => [], patchTask: () => undefined, state,
    setHeartbeat: () => ({ unref() {} }), clearHeartbeat: () => undefined, ...options,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, service, state };
}

function seed(service, id, value) {
  const path = service.taskRuntimeLeasePath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

test("a stale lease is not reclaimed while another worker holds the reclaim lock", (t) => {
  const f = fixture(t);
  const path = seed(f.service, "busy", deadLease());
  mkdirSync(`${path}.reclaim`);
  assert.equal(f.service.acquireTaskLease("busy"), false);
  assert.equal(read(path).token, "dead-owner");
  assert.equal(existsSync(`${path}.reclaim`), true);
});

test("a reclaim lock left by a crashed worker is recovered after its stale limit", (t) => {
  const f = fixture(t);
  const path = seed(f.service, "crashed", deadLease());
  mkdirSync(`${path}.reclaim`);
  const old = new Date(Date.now() - RECLAIM_LOCK_STALE_MS - 5_000);
  utimesSync(`${path}.reclaim`, old, old);
  assert.equal(f.service.acquireTaskLease("crashed"), true);
  assert.equal(read(path).token, f.state.token);
  assert.equal(existsSync(`${path}.reclaim`), false);
  f.service.releaseTaskLease("crashed");
});

test("the reclaim lock never outlives a successful or refused acquisition", (t) => {
  const f = fixture(t);
  const won = seed(f.service, "won", deadLease());
  assert.equal(f.service.acquireTaskLease("won"), true);
  assert.equal(existsSync(`${won}.reclaim`), false);
  // A healthy foreign owner is refused before any reclaim is attempted.
  const live = seed(f.service, "live", { token: "other", pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now() });
  assert.equal(f.service.acquireTaskLease("live"), false);
  assert.equal(existsSync(`${live}.reclaim`), false);
  f.service.releaseTaskLease("won");
});

test("re-validating under the reclaim lock keeps a lease that became live meanwhile", (t) => {
  let probes = 0;
  // The first liveness probe says dead (stale); by the time the lock is held the owner is live.
  const f = fixture(t, { isProcessAlive: () => { probes += 1; return probes > 1; } });
  const path = seed(f.service, "flip", { token: "other", pid: 4242, acquiredAt: Date.now(), heartbeatAt: Date.now() });
  assert.equal(f.service.acquireTaskLease("flip"), false);
  assert.equal(read(path).token, "other");
  assert.equal(existsSync(`${path}.reclaim`), false);
});

async function nextMessage(child) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await Promise.race([
      once(child, "message", { signal: controller.signal }).then(([message]) => message),
      once(child, "exit", { signal: controller.signal }).then(([code]) => { throw new Error(`worker exited early: ${code}`); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}

async function raceOnce(t, round, workers) {
  const f = fixture(t);
  const go = join(f.root, "go");
  const path = seed(f.service, "contended", deadLease());
  const moduleUrl = new URL("./task-runtime-lease.mjs", import.meta.url).href;
  const code = `
    import { existsSync } from "node:fs";
    import { TaskLeaseService } from ${JSON.stringify(moduleUrl)};
    const service = new TaskLeaseService({ dataDir: () => ${JSON.stringify(f.root)}, listTasks: () => [], patchTask: () => undefined });
    process.send({ ready: true, pid: process.pid });
    while (!existsSync(${JSON.stringify(go)})) { /* spin so every worker starts together */ }
    process.send({ acquired: service.acquireTaskLease("contended"), pid: process.pid });
    // Stay alive until told to stop: a finished winner would look dead and be legitimately reclaimed.
    process.on("message", () => process.exit(0));
  `;
  // Keep stderr: a worker that dies at startup must say why instead of "exited early".
  const stderrByChild = new Map();
  const children = Array.from({ length: workers }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
    stderrByChild.set(child, () => stderr);
    return child;
  });
  const stopAll = async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.send("stop");
      await exited;
    }));
  };
  t.after(stopAll);
  // Wait until every process is spinning on the go file, so the race is a race and not
  // a measure of process startup time (the suite runs files in parallel).
  const ready = await Promise.all(children.map(async (child) => {
    try {
      return await nextMessage(child);
    } catch (error) {
      const stderr = stderrByChild.get(child)?.().trim();
      throw new Error(stderr ? `${error.message}: ${stderr}` : error.message);
    }
  }));
  assert.deepEqual(ready.map((message) => message.ready), Array(workers).fill(true));
  writeFileSync(go, "go");
  const results = await Promise.all(children.map((child) => nextMessage(child)));
  const owner = read(path);
  await stopAll();
  return { results, owner, reclaimLeft: existsSync(`${path}.reclaim`) };
}

test("racing Node processes over one stale lease produce exactly one owner each round", { timeout: 40_000 }, async (t) => {
  for (let round = 0; round < 4; round += 1) {
    // A worker that cannot even start under load is an environment failure, not a
    // multi-owner failure: retry the round, but never accept a run with two winners.
    let attempt = 0;
    for (;;) {
      try {
        const { results, owner, reclaimLeft } = await raceOnce(t, round, 5);
        const winners = results.filter((result) => result.acquired);
        assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
        assert.equal(owner.pid, winners[0].pid, `round ${round}: the lease must belong to the reported winner`);
        assert.equal(reclaimLeft, false);
        break;
      } catch (error) {
        attempt += 1;
        const startupFailure = /exited early/.test(error.message);
        if (!startupFailure || attempt >= 3) throw error;
      }
    }
  }
});

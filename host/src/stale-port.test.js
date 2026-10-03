import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLeafCodeWebUi, reclaimStalePort } from "./stale-port.js";

const NEXT = "node /x/node_modules/next/dist/bin/next start --hostname 100.1.1.1 --port 3010";

function harness({ pids, procs, lock, alive = () => false }) {
  const stopped = [];
  let held = new Set(pids);
  return {
    stopped,
    options: {
      port: 3010,
      platform: "linux",
      selfPid: 1,
      lockFile: lock ?? "/nonexistent/host.lock",
      pidAlive: alive,
      getListeningPids: () => [...held],
      commandLine: (pid) => procs[pid]?.cmd ?? "",
      environment: (pid) => procs[pid]?.env ?? [],
      stop: async (pid) => {
        stopped.push(pid);
        held.delete(pid);
      },
      sleep: async () => {},
      releaseTries: 2,
    },
  };
}

test("recognizes the renamed next-server by the host-set port environment", () => {
  assert.equal(isLeafCodeWebUi(3010, { commandLine: "next-server (v15.5.0)", environment: ["LEAFCODE_PI_PORT=3010"] }), true);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: "next-server (v15.5.0)", environment: ["LEAFCODE_PI_PORT=3011"] }), false);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: NEXT, environment: [] }), true);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: NEXT.replace("3010", "30100"), environment: [] }), false);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: "python -m http.server 3010", environment: ["LEAFCODE_PI_PORT=3010"] }), false);
});

test("stops an orphaned WebUI and leaves other programs alone", async () => {
  const { options, stopped } = harness({
    pids: [10, 20],
    procs: { 10: { cmd: NEXT }, 20: { cmd: "nginx: master" } },
  });
  const result = await reclaimStalePort(options);
  assert.deepEqual(stopped, [10]);
  assert.deepEqual(result.stopped, [10]);
  assert.deepEqual(result.foreign, [{ pid: 20, commandLine: "nginx: master" }]);
});

test("does nothing while the host from host.lock is alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-port-"));
  try {
    const lockFile = join(dir, "host.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: 4242 }));
    const live = harness({ pids: [10], procs: { 10: { cmd: NEXT } }, lock: lockFile, alive: (pid) => pid === 4242 });
    const result = await reclaimStalePort(live.options);
    assert.match(result.skipped, /4242/);
    assert.deepEqual(live.stopped, []);

    const dead = harness({ pids: [10], procs: { 10: { cmd: NEXT } }, lock: lockFile, alive: () => false });
    await reclaimStalePort(dead.options);
    assert.deepEqual(dead.stopped, [10]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is a no-op when the port is free", async () => {
  const { options, stopped } = harness({ pids: [], procs: {} });
  const result = await reclaimStalePort(options);
  assert.deepEqual(stopped, []);
  assert.deepEqual(result.foreign, []);
});

test("skips on Windows", async () => {
  const { options } = harness({ pids: [10], procs: { 10: { cmd: NEXT } } });
  assert.equal((await reclaimStalePort({ ...options, platform: "win32" })).skipped, "unsupported platform");
});

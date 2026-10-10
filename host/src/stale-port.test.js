import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLeafCodeWebUi, reclaimStalePort } from "./stale-port.js";

const GATEWAY = "node /x/.spa/generations/11111111-1111-4111-8111-111111111111/gateway/dist/gateway/src/index.mjs";

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

test("recognizes only native UUID generation entries with the matching Host port", () => {
  const environment = ["LEAFCODE_PI_PORT=3010"];
  assert.equal(isLeafCodeWebUi(3010, { commandLine: GATEWAY, environment }), true);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: GATEWAY, environment: [] }), false);
  assert.equal(isLeafCodeWebUi(3011, { commandLine: GATEWAY, environment }), false);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: GATEWAY.replace("11111111-1111-4111-8111-111111111111", "arbitrary"), environment }), false);
  assert.equal(isLeafCodeWebUi(3010, { commandLine: "python -m http.server 3010", environment }), false);
});

test("stops an orphaned WebUI and leaves other programs alone", async () => {
  const { options, stopped } = harness({
    pids: [10, 20],
    procs: { 10: { cmd: GATEWAY, env: ["LEAFCODE_PI_PORT=3010"] }, 20: { cmd: "nginx: master" } },
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
    const live = harness({ pids: [10], procs: { 10: { cmd: GATEWAY, env: ["LEAFCODE_PI_PORT=3010"] } }, lock: lockFile, alive: (pid) => pid === 4242 });
    const result = await reclaimStalePort(live.options);
    assert.match(result.skipped, /4242/);
    assert.deepEqual(live.stopped, []);

    const dead = harness({ pids: [10], procs: { 10: { cmd: GATEWAY, env: ["LEAFCODE_PI_PORT=3010"] } }, lock: lockFile, alive: () => false });
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
  const { options } = harness({ pids: [10], procs: { 10: { cmd: GATEWAY, env: ["LEAFCODE_PI_PORT=3010"] } } });
  assert.equal((await reclaimStalePort({ ...options, platform: "win32" })).skipped, "unsupported platform");
});

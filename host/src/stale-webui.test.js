import assert from "node:assert/strict";
import test from "node:test";
import { stopOrphanedWebUi } from "./stale-webui.js";

const MIRROR = "/cache/leafcode-pi/build/LeafCodePi-abc";

function run(overrides) {
  const stoppedCalls = [];
  const promise = stopOrphanedWebUi({
    port: 3010,
    projectDirs: [MIRROR, "/repo/web"],
    platform: "linux",
    selfPid: 100,
    getListeningPids: () => [100, 200, 300],
    cwdOf: (pid) => ({ 100: MIRROR, 200: MIRROR, 300: "/somewhere/else" })[pid] ?? null,
    stopProcessTreeGracefully: async ({ pid }) => {
      stoppedCalls.push(pid);
      return "soft";
    },
    ...overrides,
  });
  return promise.then((stopped) => ({ stopped, stoppedCalls }));
}

test("stops only listeners running from this install's WebUI directories", async () => {
  const { stopped, stoppedCalls } = await run();
  assert.deepEqual(stopped, [200]);
  assert.deepEqual(stoppedCalls, [200]);
});

test("never stops the host itself or excluded PIDs", async () => {
  const { stopped } = await run({ excludePids: [200] });
  assert.deepEqual(stopped, []);
});

test("leaves listeners with an unreadable cwd alone", async () => {
  const { stopped } = await run({ cwdOf: () => null });
  assert.deepEqual(stopped, []);
});

test("does nothing outside Linux", async () => {
  const { stopped } = await run({ platform: "darwin" });
  assert.deepEqual(stopped, []);
});

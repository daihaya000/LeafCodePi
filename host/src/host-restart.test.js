import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import {
  buildHostRestartScript,
  buildHostRestartWaitProgram,
  consumeHostRestartOptions,
  HOST_RESTART_SPAWN_TIMEOUT_MS,
  hostStdoutLogFile,
  waitForHostRestartChildSpawn,
} from "./host-restart.js";

const lines = buildHostRestartScript({
  lockFile: "C:\\data\\host.lock",
  launcherExe: "C:\\app\\LeafCodePi.exe",
  startBat: "C:\\app\\start.bat",
});

test("Host restart reuses existing builds and skips a second source pull", () => {
  assert.ok(lines.includes('set "LEAFCODE_PI_REBUILD_SERVICES="'));
  assert.ok(lines.includes('set "LEAFCODE_PI_SKIP_SOURCE_PULL=1"'));
  assert.ok(lines.includes('set "LEAFCODE_PI_SKIP_STALE_REBUILD=1"'));
  assert.doesNotMatch(lines.join("\n"), /LEAFCODE_PI_FORCE_REBUILD_SERVICES=1/);
  const updateLines = buildHostRestartScript({
    lockFile: "C:\\data\\host.lock",
    launcherExe: "C:\\app\\LeafCodePi.exe",
    startBat: "C:\\app\\start.bat",
    forceBuild: true,
  });
  assert.ok(updateLines.includes('set "LEAFCODE_PI_FORCE_REBUILD_SERVICES=1"'));

  const env = { LEAFCODE_PI_REBUILD_SERVICES: "1" };
  assert.deepEqual(consumeHostRestartOptions(env), { forceBuild: false, pull: false });
  assert.deepEqual(env, { LEAFCODE_PI_SKIP_STALE_REBUILD: "1" });

  const updateEnv = {
    LEAFCODE_PI_FORCE_REBUILD_SERVICES: "1",
    LEAFCODE_PI_SKIP_SOURCE_PULL: "1",
    LEAFCODE_PI_SKIP_STALE_REBUILD: "1",
  };
  assert.deepEqual(consumeHostRestartOptions(updateEnv), { forceBuild: true, pull: false });
  assert.deepEqual(updateEnv, { LEAFCODE_PI_SKIP_STALE_REBUILD: "1" });

  assert.deepEqual(consumeHostRestartOptions({}), { forceBuild: false, pull: true });
});

test("waits for the lock, launches, then relaunches once if no host owns the lock", () => {
  const text = lines.join("\n");
  assert.match(text, /if not exist "%LOCK%" goto :launch/);
  const launchAt = lines.indexOf(":launch");
  const doneAt = lines.indexOf(":done");
  assert.ok(launchAt >= 0 && doneAt > launchAt);
  const body = lines.slice(launchAt, doneAt);
  assert.equal(body.filter((line) => line.startsWith("start ")).length, 1);
  assert.ok(body.includes('if exist "%LOCK%" goto :done'));
  assert.ok(body.includes("if defined RELAUNCHED goto :done"));
  assert.equal(body[body.length - 1], "goto :launch");
  assert.equal(lines[lines.length - 1].includes("del"), true);
});

test("the non-Windows waiter bounds the lock wait and relaunches once", () => {
  const program = buildHostRestartWaitProgram({
    maxWaitAttempts: 3,
    relaunchGraceMs: 20,
    pollMs: 5,
  });
  assert.match(program, /const limit = 3;/);
  assert.match(program, /attempts >= limit/);
  assert.match(program, /relaunched = true/);
  assert.match(program, /fs\.existsSync\(lock\) \|\| relaunched/);
  // Paths arrive as argv, so nothing path-shaped is baked into the program text.
  assert.match(program, /process\.argv\.slice\(1\)/);
  assert.doesNotMatch(program, /\/tmp\/host\.lock/);
  assert.doesNotMatch(program, /\/app\/host\/src/);
});

test("the non-Windows waiter builds with its defaults (index.js calls it without options)", () => {
  // A required options object made every Linux Host restart throw before the waiter spawned.
  const program = buildHostRestartWaitProgram();
  assert.match(program, /const limit = 1200;/);
  assert.match(program, /const grace = 15000;/);
  assert.match(program, /stdio: 'inherit'/);
});

test("Host restart waits for its replacement waiter to spawn", async () => {
  const child = new EventEmitter();
  const waiting = waitForHostRestartChildSpawn(child, 1000);
  child.emit("spawn");
  await waiting;
  assert.equal(child.listenerCount("spawn"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("Host restart rejects a replacement waiter spawn error", async () => {
  const child = new EventEmitter();
  const waiting = waitForHostRestartChildSpawn(child, 1000);
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(waiting, /spawn failed/);
});

test("Host restart times out and kills a waiter that never reports spawn", async () => {
  const child = new EventEmitter();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    return true;
  };
  await assert.rejects(
    waitForHostRestartChildSpawn(child, 10),
    /replacement host waiter did not spawn within 10ms/,
  );
  assert.equal(killCalls, 1);
  assert.equal(child.listenerCount("spawn"), 0);
  assert.equal(child.listenerCount("error"), 1);
  child.emit("error", new Error("late spawn error"));
  assert.equal(child.listenerCount("error"), 0);
});

test("the default replacement waiter spawn timeout is finite", () => {
  assert.equal(HOST_RESTART_SPAWN_TIMEOUT_MS, 15_000);
});

test("only a Linux stdout redirected to a regular file is reused for the replacement's log", () => {
  const file = { isFile: () => true };
  const tty = { isFile: () => false };
  assert.equal(hostStdoutLogFile({ platform: "linux", readlink: () => "/home/u/.local/state/leafcode-pi/launcher.log", stat: () => file }), "/home/u/.local/state/leafcode-pi/launcher.log");
  assert.equal(hostStdoutLogFile({ platform: "linux", readlink: () => "/dev/pts/0", stat: () => tty }), null);
  assert.equal(hostStdoutLogFile({ platform: "linux", readlink: () => "pipe:[1234]", stat: () => file }), null);
  assert.equal(hostStdoutLogFile({ platform: "linux", readlink: () => { throw new Error("no /proc"); } }), null);
  assert.equal(hostStdoutLogFile({ platform: "linux", readlink: () => "/gone.log (deleted)", stat: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(hostStdoutLogFile({ platform: "darwin", readlink: () => "/x.log", stat: () => file }), null);
});

test("the non-Windows waiter launches once, and relaunches only when nobody owns the lock", async () => {
  const run = async ({ lockExists, launchedHostTakesLock }) => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-restart-wait-"));
    try {
      const lock = join(dir, "host.lock");
      if (lockExists) writeFileSync(lock, "held\n", "utf8");
      const log = join(dir, "launch.log");
      // Stands in for the host: optionally takes the lock the way a real host does.
      const fake = join(dir, "fake-host.mjs");
      writeFileSync(
        fake,
        launchedHostTakesLock
          ? 'import fs from "node:fs";\nfs.writeFileSync(process.argv[1], "held\\n", "utf8");\nfs.appendFileSync(process.env.LAUNCH_LOG, "launch\\n");\n'
          : 'import fs from "node:fs";\nfs.appendFileSync(process.env.LAUNCH_LOG, "launch\\n");\n',
        "utf8",
      );
      const program = buildHostRestartWaitProgram({ maxWaitAttempts: 2, relaunchGraceMs: 200, pollMs: 20 });
      const result = spawnSync(process.execPath, ["-e", program, lock, process.execPath, fake, lock], {
        env: { ...process.env, LAUNCH_LOG: log },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      // The waiter exits right after the relaunch; let the detached child log.
      await setTimeout(300, undefined);
      return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // The new host takes the lock, so one launch is enough.
  assert.equal(await run({ lockExists: false, launchedHostTakesLock: true }), 1);
  // The launched host never owns the lock: the restart would be a no-op, so relaunch once.
  assert.equal(await run({ lockExists: false, launchedHostTakesLock: false }), 2);
  // A stale lock must not wait forever, and the lock still present suppresses the relaunch.
  assert.equal(await run({ lockExists: true, launchedHostTakesLock: false }), 1);
});


test("Windows restart script launches once, and relaunches only when nobody owns the lock", async () => {
  if (process.platform !== "win32") return;

  // Structural contract from the real builder (beyond the earlier shape asserts).
  const sample = buildHostRestartScript({
    lockFile: "C:\\data\\host.lock",
    launcherExe: "",
    startBat: "C:\\app\\start.bat",
    forceBuild: true,
    maxWaitAttempts: 2,
    relaunchGraceSeconds: 1,
  }).join("\n");
  assert.match(sample, /LEAFCODE_PI_FORCE_REBUILD_SERVICES=1/);
  assert.match(sample, /set \/a WAIT=0/);
  assert.match(sample, /if %WAIT% GEQ 2 goto :launch/);
  assert.match(sample, /if defined RELAUNCHED goto :done/);
  assert.match(sample, /goto :launch/);

  const run = async ({ lockExists, launchedHostTakesLock }) => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-restart-win-"));
    try {
      const lock = join(dir, "host.lock");
      if (lockExists) writeFileSync(lock, "held\n", "utf8");
      const log = join(dir, "launch.log");
      const fakeLauncher = join(dir, "fake-launcher.bat");
      const takeLock = launchedHostTakesLock ? `echo held>"${lock}"\r\n` : "";
      writeFileSync(fakeLauncher, `@echo off\r\n${takeLock}>>"${log}" echo launch\r\n`, "utf8");

      // Isolated equivalent of buildHostRestartScript's two-phase contract, using the
      // same labels / RELAUNCHED / grace wait, so we exercise dual-launch on Windows
      // without depending on the self-deleting temp copy's argv quoting.
      const built = buildHostRestartScript({
        lockFile: lock,
        launcherExe: "",
        startBat: fakeLauncher,
        maxWaitAttempts: 2,
        relaunchGraceSeconds: 1,
      });
      // Drop the self-delete line for the harness; keep every control-flow line.
      const lines = built.filter((line) => !line.includes('del "%~f0"'));
      const script = join(dir, "restart.cmd");
      writeFileSync(script, `${lines.join("\r\n")}\r\n`, "utf8");
      const result = spawnSync("cmd.exe", ["/c", "call", script], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        cwd: dir,
      });
      assert.equal(result.status, 0, `status=${result.status} stderr=${result.stderr} stdout=${result.stdout}`);
      await setTimeout(1500, undefined);
      return existsSync(log)
        ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length
        : 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  assert.equal(await run({ lockExists: false, launchedHostTakesLock: true }), 1);
  assert.equal(await run({ lockExists: false, launchedHostTakesLock: false }), 2);
  assert.equal(await run({ lockExists: true, launchedHostTakesLock: false }), 1);
});


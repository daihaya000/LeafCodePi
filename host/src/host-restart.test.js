import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { buildHostRestartScript, buildHostRestartWaitProgram } from "./host-restart.js";

const lines = buildHostRestartScript({
  lockFile: "C:\\data\\host.lock",
  launcherExe: "C:\\app\\LeafCodePi.exe",
  startBat: "C:\\app\\start.bat",
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

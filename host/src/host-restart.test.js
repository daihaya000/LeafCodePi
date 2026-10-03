import assert from "node:assert/strict";
import test from "node:test";
import { buildHostRestartScript } from "./host-restart.js";

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

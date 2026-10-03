export function buildHostRestartScript({ lockFile, launcherExe, startBat, maxWaitAttempts = 120, relaunchGraceSeconds = 15 }) {
  const launchLine = launcherExe
    ? `start "LeafCodePi" /min "${launcherExe}"`
    : `start "LeafCodePi" /min cmd.exe /c ""${startBat}" >nul 2>&1"`;
  return [
    "@echo off",
    "setlocal",
    "set \"LEAFCODE_PI_SKIP_STALE_REBUILD=1\"",
    `set "LOCK=${lockFile}"`,
    "set /a WAIT=0",
    ":wait",
    'if not exist "%LOCK%" goto :launch',
    "set /a WAIT+=1",
    `if %WAIT% GEQ ${maxWaitAttempts} goto :launch`,
    "ping -n 2 127.0.0.1 >nul",
    "goto :wait",
    ":launch",
    launchLine,
    // If the old host outlived the wait, the new one exits on the held lock and the old one then quits:
    // nothing is left running. Check once after a grace period and relaunch if no host owns the lock.
    `ping -n ${relaunchGraceSeconds + 1} 127.0.0.1 >nul`,
    'if exist "%LOCK%" goto :done',
    "if defined RELAUNCHED goto :done",
    'set "RELAUNCHED=1"',
    "goto :launch",
    ":done",
    "endlocal",
    'del "%~f0" >nul 2>&1',
  ];
}

/**
 * Non-Windows restart waiter, kept beside the batch script so both platforms share
 * the same two-phase contract: bound the wait for our own lock to clear (a stale
 * lock must not wait forever), then relaunch once if no host owns the lock after a
 * grace period. Returns the `-e` program that `spawn(process.execPath, ...)` runs.
 * The lock, executable and entry arrive as argv, so nothing is interpolated into
 * the program text; only the tunables below are baked in.
 */
export function buildHostRestartWaitProgram({
  maxWaitAttempts = 1200,
  relaunchGraceMs = 15_000,
  pollMs = 100,
}) {
  return [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const [lock, executable, entry, maxAttempts, graceMs, intervalMs] = process.argv.slice(1);",
    `const limit = ${Number(maxWaitAttempts)};`,
    `const grace = ${Number(relaunchGraceMs)};`,
    `const interval = ${Number(pollMs)};`,
    "let attempts = 0;",
    "let relaunched = false;",
    "const launch = () => { const child = spawn(executable, [entry], { detached: true, stdio: 'ignore', env: process.env }); child.unref(); };",
    // Phase 1: our lock clears on quit. Bound the wait so a lock left behind by a
    // killed host cannot strand the restart.
    "const waitForLock = () => {",
    "  if (!fs.existsSync(lock) || attempts >= limit) { settle(); return; }",
    "  attempts += 1;",
    "  setTimeout(waitForLock, interval);",
    "};",
    // Phase 2: if the launched host exited on a lock we never saw released, nothing
    // is running. Relaunch exactly once so the restart is not a no-op.
    "const settle = () => {",
    "  launch();",
    "  setTimeout(() => {",
    "    if (fs.existsSync(lock) || relaunched) return;",
    "    relaunched = true;",
    "    launch();",
    "  }, grace);",
    "};",
    "waitForLock();",
  ].join("\n");
}

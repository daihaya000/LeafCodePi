import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [timeoutValue, cancellationPath, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);

if (!cancellationPath || !command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write("leafcode-memory watchdog: invalid invocation\n");
  process.exit(2);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

// Record the tree root so the caller can still clean up when this watchdog is
// SIGKILLed (a timeout in `pi.exec`) — signals sent from here never arrive then,
// and the detached child would keep running with its own grandchildren.
if (cancellationPath !== "-" && child.pid) {
  try {
    writeFileSync(`${cancellationPath}.pid`, String(child.pid), "utf8");
  } catch {
    /* the pid file only helps cleanup; a missing file is not fatal */
  }
}

/**
 * Orphan guarantee when the caller and this watchdog are both SIGKILLed (127).
 * - Windows: the child is spawned non-detached, so libuv places it in its
 *   KILL_ON_JOB_CLOSE job object; killing this watchdog kills the child, and the
 *   child's own libuv job kills its non-detached descendants.
 * - POSIX: the child leads its own process group (detached), which outlives a
 *   SIGKILLed watchdog. A tiny detached reaper polls this watchdog and, once it
 *   is gone, SIGTERM→SIGKILLs the child's group. On a normal close the watchdog
 *   stops the reaper so previous semantics are unchanged.
 */
const REAPER_PROGRAM = [
  "const [watchdogPid, groupId] = process.argv.slice(1).map(Number);",
  "const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };",
  "const timer = setInterval(() => {",
  "  if (!alive(-groupId)) { clearInterval(timer); process.exit(0); }",
  "  if (alive(watchdogPid)) return;",
  "  clearInterval(timer);",
  "  try { process.kill(-groupId, 'SIGTERM'); } catch {}",
  "  setTimeout(() => { try { process.kill(-groupId, 'SIGKILL'); } catch {} process.exit(0); }, 500);",
  "}, 200);",
].join("\n");

function startPosixReaper(childPid) {
  if (process.platform === "win32" || !childPid) return null;
  try {
    const reaper = spawn(process.execPath, ["-e", REAPER_PROGRAM, String(process.pid), String(childPid)], {
      detached: true,
      stdio: "ignore",
    });
    reaper.on("error", () => {});
    reaper.unref();
    return reaper;
  } catch {
    return null;
  }
}

const reaper = startPosixReaper(child.pid);

function stopReaper() {
  if (!reaper?.pid) return;
  try { reaper.kill("SIGKILL"); } catch { /* already gone */ }
}

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

let timedOut = false;
let cancelled = false;
let terminating = false;
let forceTimer;

function signalTree(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function terminateTree() {
  if (terminating) return;
  terminating = true;
  signalTree("SIGTERM");
  forceTimer = setTimeout(() => signalTree("SIGKILL"), 500);
  forceTimer.unref();
}

const timeout = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`[leafcode-memory] child timed out after ${timeoutMs}ms; terminating process tree\n`);
  terminateTree();
}, timeoutMs);
timeout.unref();

const cancellationPoll = cancellationPath === "-" ? undefined : setInterval(() => {
  if (!existsSync(cancellationPath)) return;
  cancelled = true;
  process.stderr.write("[leafcode-memory] child cancellation requested; terminating process tree\n");
  terminateTree();
}, 25);
cancellationPoll?.unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, terminateTree);
}

child.once("error", (error) => {
  stopReaper();
  clearTimeout(timeout);
  if (cancellationPoll) clearInterval(cancellationPoll);
  if (forceTimer) clearTimeout(forceTimer);
  process.stderr.write(`leafcode-memory watchdog: ${error.message}\n`);
  process.exitCode = timedOut ? 124 : cancelled ? 143 : 127;
});

child.once("close", (code, signal) => {
  stopReaper();
  clearTimeout(timeout);
  if (cancellationPoll) clearInterval(cancellationPoll);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) {
    process.exitCode = 124;
  } else if (cancelled) {
    process.exitCode = 143;
  } else if (typeof code === "number") {
    process.exitCode = code;
  } else {
    process.exitCode = signal === "SIGTERM" ? 143 : 1;
  }
});

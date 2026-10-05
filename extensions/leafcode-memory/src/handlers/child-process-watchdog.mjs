import { spawn } from "node:child_process";
import * as fs from "node:fs";
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
 * Linux: every live descendant of `roots` as pid -> start ticks (from /proc). A process that
 * calls setsid (Node `detached: true`, Pi's own bash tool, `setsid`, daemons) leaves the child's
 * process group, so `kill(-group)` alone never reaches it. Start ticks guard against PID reuse.
 * Kept self-contained so it can be serialized into the reaper program below.
 */
function linuxDescendants(fsModule, roots) {
  const out = new Map();
  if (process.platform !== "linux") return out;
  const children = new Map();
  let names;
  try { names = fsModule.readdirSync("/proc"); } catch { return out; }
  const starts = new Map();
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = fsModule.readFileSync("/proc/" + name + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const pid = Number(name), ppid = Number(fields[1]);
      starts.set(pid, fields[19]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    } catch { /* exited while scanning */ }
  }
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const pid of children.get(parent) ?? []) {
      if (out.has(pid)) continue;
      out.set(pid, starts.get(pid));
      queue.push(pid);
    }
  }
  return out;
}

/** Linux start ticks of one pid, or undefined once it is gone. Serialized with the helper above. */
function linuxStartTicks(fsModule, pid) {
  try {
    const stat = fsModule.readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/**
 * Orphan guarantee when the caller and this watchdog are both SIGKILLed (127).
 * - Windows: the child is spawned non-detached, so libuv places it in its
 *   KILL_ON_JOB_CLOSE job object; killing this watchdog kills the child, and the
 *   child's own libuv job kills its non-detached descendants.
 * - POSIX: the child leads its own process group (detached), which outlives a
 *   SIGKILLed watchdog. A tiny detached reaper polls this watchdog and, once it
 *   is gone, SIGTERM→SIGKILLs the child's group. On Linux it also remembers every
 *   descendant it has seen, so one that escaped into its own session (and was
 *   reparented to init when the child died) is still killed. On a normal close the
 *   watchdog stops the reaper so previous semantics are unchanged.
 */
const REAPER_PROGRAM = [
  "const fs = require('node:fs');",
  `const linuxDescendants = ${linuxDescendants.toString()};`,
  `const linuxStartTicks = ${linuxStartTicks.toString()};`,
  "const [watchdogPid, groupId] = process.argv.slice(1).map(Number);",
  "const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };",
  "const known = new Map();",
  "const track = () => {",
  "  for (const [pid, start] of linuxDescendants(fs, [groupId, ...known.keys()])) if (!known.has(pid)) known.set(pid, start);",
  "  for (const [pid, start] of known) if (linuxStartTicks(fs, pid) !== start) known.delete(pid);",
  "};",
  "const signalAll = (signal) => {",
  "  try { process.kill(-groupId, signal); } catch {}",
  "  for (const [pid, start] of known) {",
  "    if (linuxStartTicks(fs, pid) !== start) continue;",
  "    try { process.kill(-pid, signal); } catch {}",
  "    try { process.kill(pid, signal); } catch {}",
  "  }",
  "};",
  "const timer = setInterval(() => {",
  "  track();",
  "  if (!alive(-groupId) && known.size === 0) { clearInterval(timer); process.exit(0); }",
  "  if (alive(watchdogPid)) return;",
  "  clearInterval(timer);",
  "  signalAll('SIGTERM');",
  "  setTimeout(() => { track(); signalAll('SIGKILL'); process.exit(0); }, 500);",
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

/** Descendants seen at termination time (Linux); they may have left the child's group via setsid. */
let escapedDescendants = new Map();

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
  for (const [pid, start] of linuxDescendants(fs, [child.pid, ...escapedDescendants.keys()])) {
    if (!escapedDescendants.has(pid)) escapedDescendants.set(pid, start);
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
  for (const [pid, start] of escapedDescendants) {
    if (linuxStartTicks(fs, pid) !== start) continue;
    try { process.kill(-pid, signal); } catch {}
    try { process.kill(pid, signal); } catch {}
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

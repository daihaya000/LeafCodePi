import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { BACKEND_CHILD_PROCESS_MESSAGE } from "../../shared/backend-child-process-message.mjs";
import { createBackendService, isBackendRequested, shouldRunBackend } from "./backend-service.js";

const REPO_ROOT = join("C:", "repo");

/** A fake child process: the tests decide when it exits. */
function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      child.emit("exit", 0, null);
    };
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

test("the Backend is off unless an operator asks for it", () => {
  for (const value of ["1", "true", "yes", "attach", " ATTACH "]) {
    assert.equal(isBackendRequested({ LEAFCODE_PI_BACKEND: value }), true, value);
  }
  for (const value of ["", "0", "no", "maybe", undefined]) {
    assert.equal(isBackendRequested({ LEAFCODE_PI_BACKEND: value }), false, String(value));
  }
});

test("production runs the Backend by default, and only an explicit opt-out stops it", () => {
  assert.equal(shouldRunBackend({}), true);
  assert.equal(shouldRunBackend({ LEAFCODE_PI_MODE: "prod" }), true);
  assert.equal(shouldRunBackend({ LEAFCODE_PI_BACKEND: "1" }), true);
  for (const value of ["0", "false", "no", "off", " OFF "]) {
    assert.equal(shouldRunBackend({ LEAFCODE_PI_BACKEND: value }), false, value);
  }
  // A development WebUI owns the runtime itself, so there is no Backend to run next to it.
  assert.equal(shouldRunBackend({ LEAFCODE_PI_MODE: "dev" }), false);
  assert.equal(shouldRunBackend({ LEAFCODE_PI_BACKEND: "dev" }), false);
});

test("starting spawns the planned Backend once, with the pinned generation", () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t".repeat(40), spawn, generation: "gen-a" });
  assert.deepEqual(service.status(), { state: "idle", generation: "gen-a", runtime: "detached", restarts: 0 });
  service.start();
  service.start();
  assert.equal(calls.length, 1, "a running Backend is not started twice");
  assert.deepEqual(calls[0].args, [join(REPO_ROOT, "backend", "src", "entry.mjs")]);
  assert.equal(calls[0].options.env.LEAFCODE_PI_BACKEND_TOKEN, "t".repeat(40));
  assert.equal(calls[0].options.env.LEAFCODE_PI_BACKEND_GENERATION, "gen-a");
  assert.equal(calls[0].options.env.LEAFCODE_PI_BACKEND_RUNTIME, "", "the Web still owns the runtime");
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe", "ipc"]);
  assert.equal(service.status().state, "running");
  assert.equal(children.length, 1);
});

test("Backend stdout and stderr are consumed and forwarded to the output sink", () => {
  const { spawn, children } = fakeSpawn();
  const output = [];
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn,
    generation: "gen-a",
    onOutput: (level, text) => output.push({ level, text }),
  });
  service.start();
  const child = children[0];

  child.stdout.emit("data", Buffer.from("ready\n"));
  child.stderr.emit("data", Buffer.from("warning\n"));

  assert.deepEqual(output, [
    { level: "log", text: "ready\n" },
    { level: "error", text: "warning\n" },
  ]);
  assert.equal(child.stdout.listenerCount("data"), 1);
  assert.equal(child.stderr.listenerCount("data"), 1);

  child.emit("exit", 1, null);
  const replacement = children[1];
  replacement.stdout.emit("data", "restarted\n");
  replacement.stderr.emit("data", "new warning\n");
  assert.deepEqual(output.slice(2), [
    { level: "log", text: "restarted\n" },
    { level: "error", text: "new warning\n" },
  ]);
  assert.equal(replacement.stdout.listenerCount("data"), 1);
  assert.equal(replacement.stderr.listenerCount("data"), 1);
  service.stop();
});

for (const sinkMode of ["capture", "absent", "throw"]) {
  test(`Backend output pipes drain beyond capacity with ${sinkMode} sink`, { timeout: 10_000 }, async (t) => {
    const payloadBytes = 256 * 1024;
    const fixture = `
      const payload = Buffer.alloc(${payloadBytes}, 0x78);
      const write = (stream) => new Promise((resolve, reject) => {
        stream.write(payload, (error) => error ? reject(error) : resolve());
      });
      Promise.all([write(process.stdout), write(process.stderr)])
        .then(() => process.exit(0), () => process.exit(2));
    `;
    let child;
    let closed;
    const capturedBytes = { log: 0, error: 0 };
    const service = createBackendService({
      repoRoot: REPO_ROOT,
      token: "t",
      env: process.env,
      spawn: (_command, _args, options) => {
        child = nodeSpawn(process.execPath, ["-e", fixture], { ...options, cwd: process.cwd() });
        closed = new Promise((resolve, reject) => {
          child.once("error", reject);
          // exit can precede the final data events; close follows stdio drainage.
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        return child;
      },
      generation: "gen-a",
      restartMax: 0,
      error: () => {},
      ...(sinkMode === "absent" ? {} : {
        onOutput: (level, text) => {
          capturedBytes[level] += Buffer.byteLength(text);
          if (sinkMode === "throw") throw new Error("logging sink failed");
        },
      }),
    });
    service.start();
    t.after(async () => {
      service.stop();
      await closed;
    });

    assert.deepEqual(await closed, { code: 0, signal: null });
    if (sinkMode !== "absent") {
      assert.deepEqual(capturedBytes, { log: payloadBytes, error: payloadBytes });
    }
  });
}

test("a cutover can attach after a confirmed stop on the same service", async () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  service.start();
  assert.equal(calls[0].options.env.LEAFCODE_PI_BACKEND_RUNTIME, "", "the first launch stays detached");
  // A running Backend is not relaunched by a request: the Host stops it first.
  assert.equal(service.start({ attachRuntime: true }), null);
  assert.equal(calls.length, 1);
  await service.stopForRestart();
  assert.equal(service.status().state, "idle");
  service.start({ attachRuntime: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.env.LEAFCODE_PI_BACKEND_RUNTIME, "attach");
  assert.equal(calls[1].options.env.LEAFCODE_PI_BACKEND_GENERATION, "gen-a");
  assert.equal(service.status().runtime, "attach");
  assert.equal(children.length, 2);
  service.stop();
});

test("a Backend crash reaps registered MCP child trees before restarting", async () => {
  const events = [];
  const { spawn: baseSpawn, calls, children } = fakeSpawn();
  let mcpAlive = true;
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn: (...args) => { events.push("backend-start"); return baseSpawn(...args); },
    generation: "gen-a",
    restartMax: 1,
    getProcessStartKey: (pid) => pid === 4321 ? "mcp-start" : undefined,
    processAlive: (pid) => Math.abs(pid) === 4321 && mcpAlive,
    killProcessTree: (pid, options) => {
      assert.equal(pid, 4321);
      assert.equal(options.expectedProcessStartKey, "mcp-start");
      events.push("mcp-tree-kill");
      mcpAlive = false;
      return true;
    },
  });
  service.start();
  children[0].emit("message", {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "started",
    token: "mcp-a",
    pid: 4321,
    processKey: "mcp-start",
  });

  children[0].emit("exit", 1, null);
  assert.equal(calls.length, 1, "the replacement waits for child-tree cleanup");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["backend-start", "mcp-tree-kill", "backend-start"]);
  assert.equal(calls.length, 2);
  assert.equal(service.status().state, "running");
  service.stop();
});

test("Host waits for the delayed child identity before reaping", async () => {
  const { spawn, calls, children } = fakeSpawn();
  let mcpAlive = true;
  let killCount = 0;
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn,
    generation: "gen-a",
    getProcessStartKey: () => "mcp-start",
    processAlive: (pid) => Math.abs(pid) === 4321 && mcpAlive,
    killProcessTree: () => { killCount += 1; mcpAlive = false; return true; },
  });
  service.start();
  children[0].emit("message", {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "started",
    token: "mcp-a",
    pid: 4321,
    processKey: null,
  });
  children[0].emit("message", {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "identity",
    token: "mcp-a",
    pid: 4321,
    processKey: "mcp-start",
  });
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(killCount, 1);
  assert.equal(calls.length, 2);
  service.stop();
});

test("real Backend IPC registers an MCP child before crash cleanup", { timeout: 10_000 }, async (t) => {
  let mcpPid = null;
  let killCount = 0;
  let backendExit;
  let backendProcess;
  let backendOutput = "";
  const fixture = `
    process.send({
      type: "leafcode:backend-child-process", action: "started", token: "mcp-live",
      pid: 4321, processKey: "mcp-start",
    }, (error) => { if (error) process.exit(2); setTimeout(() => process.exit(1), 100); });
  `;
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    env: process.env,
    spawn: (_command, _args, options) => {
      const backend = nodeSpawn(process.execPath, ["--input-type=module", "-e", fixture], { ...options, cwd: process.cwd() });
      backendProcess = backend;
      backendExit = new Promise((resolve) => {
        backend.once("exit", resolve);
        backend.once("error", resolve);
      });
      backend.on("message", (message) => {
        if (message?.type === BACKEND_CHILD_PROCESS_MESSAGE && message.action === "started") mcpPid = message.pid;
      });
      backend.stdout.on("data", (chunk) => { backendOutput += chunk.toString(); });
      backend.stderr.on("data", (chunk) => { backendOutput += chunk.toString(); });
      return backend;
    },
    generation: "gen-a",
    restartMax: 0,
    getProcessStartKey: () => "mcp-start",
    processAlive: () => mcpPid !== null && killCount === 0,
    killProcessTree: (pid, options) => {
      mcpPid = pid;
      assert.equal(pid, 4321);
      assert.equal(options.expectedProcessStartKey, "mcp-start");
      killCount += 1;
      return true;
    },
  });
  service.start();
  t.after(async () => {
    service.stop();
    await backendExit;
  });

  const deadline = Date.now() + 5_000;
  while (service.status().state !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const details = JSON.stringify({ backendPid: backendProcess?.pid, exitCode: backendProcess?.exitCode, mcpPid, killCount, backendOutput });
  assert.equal(service.status().state, "failed", details);
  assert.equal(killCount, 1, details);
  assert.ok(mcpPid > 1, details);
});

test("exit code 134 is diagnosed as an abort without asserting an OOM cause", () => {
  const { spawn, children } = fakeSpawn();
  const errors = [];
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn,
    generation: "gen-a",
    restartMax: 0,
    error: (message) => errors.push(message),
  });
  service.start();
  children[0].emit("exit", 134, null);

  assert.ok(errors.some((message) => /code 134.*possible heap out-of-memory.*Backend stderr/.test(message)));
  service.stop();
});

test("child cleanup still runs when the Backend restart budget is exhausted", async () => {
  const { spawn, calls, children } = fakeSpawn();
  let mcpAlive = true;
  let killCount = 0;
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn,
    generation: "gen-a",
    restartMax: 0,
    getProcessStartKey: () => "mcp-start",
    processAlive: () => mcpAlive,
    killProcessTree: () => { killCount += 1; mcpAlive = false; return true; },
  });
  service.start();
  children[0].emit("message", {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "started",
    token: "mcp-a",
    pid: 4321,
    processKey: "mcp-start",
  });
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(killCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(service.status().state, "failed");
});

test("unknown child identity fails closed and blocks Backend restart", async () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn,
    generation: "gen-a",
    restartMax: 1,
    getProcessStartKey: () => undefined,
    processAlive: () => true,
    killProcessTree: () => assert.fail("must not kill a PID without a verified identity"),
  });
  service.start();
  children[0].emit("message", {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "started",
    token: "mcp-a",
    pid: 4321,
    processKey: null,
  });
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(service.status().state, "failed");
  assert.equal(service.start(), null);
});

test("the WebUI child gets the Backend's address and expected generation", () => {
  const { spawn } = fakeSpawn();
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t".repeat(40),
    spawn,
    generation: "gen-a",
    env: { LEAFCODE_PI_BACKEND_PORT: "18888" },
  });
  assert.deepEqual(service.clientEnv(), {
    LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40),
    LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:18888",
    LEAFCODE_PI_BACKEND_GENERATION: "gen-a",
  });
});

test("a crash spends the Backend's own budget, then the service fails instead of looping", () => {
  const { spawn, calls, children } = fakeSpawn();
  const errors = [];
  const service = createBackendService({
    repoRoot: REPO_ROOT,
    token: "t",
    spawn,
    generation: "gen-a",
    restartMax: 2,
    error: (message) => errors.push(message),
  });
  service.start();
  for (let i = 0; i < 3; i += 1) children.at(-1).emit("exit", 1, null);
  assert.equal(calls.length, 3, "initial start plus two restarts");
  assert.equal(service.status().restarts, 3);
  assert.equal(service.status().state, "failed");
  assert.equal(errors.length, 1);
  // A failed service does not start again: the Host decides what to do with the failure.
  assert.equal(service.start(), null);
  assert.equal(calls.length, 3);
  assert.equal(errors.length, 2, "the refusal is reported, not silent");
});

test("a clean stop is not a crash, and stops the process", () => {
  const { spawn, calls, children } = fakeSpawn();
  const errors = [];
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a", error: (m) => errors.push(m) });
  service.start();
  const running = children.at(-1);
  service.stop();
  assert.equal(running.killed, true);
  assert.equal(service.status().state, "stopped");
  assert.equal(errors.length, 0, "a stop is not a failure");
  assert.throws(() => service.start(), /stopped/);
  assert.equal(calls.length, 1);
});

test("a restart stop blocks launches until exit is observed", async () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  service.start();
  const running = children[0];
  running.kill = () => true;
  const stopped = service.stopForRestart();
  assert.equal(service.status().state, "stopping");
  assert.throws(() => service.start({ attachRuntime: true }), /stopping/);
  assert.equal(calls.length, 1);
  running.emit("exit", 0, null);
  assert.throws(() => service.start({ attachRuntime: true }), /stopping/, "the pending stop must settle first");
  await stopped;
  assert.equal(service.status().state, "idle");
  assert.equal(service.status().restarts, 0, "intentional stops do not spend the crash budget");
  service.start({ attachRuntime: true });
  assert.equal(calls.length, 2);
  service.stop();
});

test("a refused kill keeps the child tracked and cannot relaunch", async () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  service.start();
  children[0].kill = () => false;
  await assert.rejects(service.stopForRestart(), /refused/);
  assert.equal(service.status().state, "stopping");
  assert.throws(() => service.start({ attachRuntime: true }), /stopping/);
  assert.equal(calls.length, 1);
  children[0].emit("exit", 0, null);
  assert.equal(service.status().state, "idle", "a later exit confirms termination");
});

test("a stop timeout keeps relaunch blocked until a late exit", async () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  service.start();
  children[0].kill = () => true;
  await assert.rejects(service.stopForRestart({ timeoutMs: 10 }), /timed out/);
  assert.equal(service.status().state, "stopping");
  assert.throws(() => service.start({ attachRuntime: true }), /stopping/);
  assert.equal(calls.length, 1);
  children[0].emit("exit", 0, null);
  assert.equal(service.status().state, "idle");
});

test("Host shutdown remains terminal even during a restart stop", async () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  service.start();
  children[0].kill = () => true;
  const pending = service.stopForRestart();
  service.stop();
  children[0].emit("exit", 0, null);
  await pending;
  assert.equal(service.status().state, "stopped");
  assert.throws(() => service.start({ attachRuntime: true }), /stopped/);
  await assert.rejects(service.stopForRestart(), /stopped/);
  assert.equal(calls.length, 1);
});

test("a service without a spawn function is refused", () => {
  assert.throws(() => createBackendService({ repoRoot: REPO_ROOT, token: "t" }), /spawn is required/);
});

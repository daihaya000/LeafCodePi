import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendService, isBackendRequested } from "./backend-service.js";

const REPO_ROOT = join("C:", "repo");

/** A fake child process: the tests decide when it exits. */
function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
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
  assert.equal(service.status().state, "running");
  assert.equal(children.length, 1);
});

test("a cutover can ask for the runtime on a fresh launch, and only then", () => {
  const { spawn, calls, children } = fakeSpawn();
  const service = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  service.start();
  assert.equal(calls[0].options.env.LEAFCODE_PI_BACKEND_RUNTIME, "", "the first launch stays detached");
  // A running Backend is not relaunched by a request: the Host stops it first.
  assert.equal(service.start({ attachRuntime: true }), null);
  assert.equal(calls.length, 1);
  service.stop();
  const restarted = createBackendService({ repoRoot: REPO_ROOT, token: "t", spawn, generation: "gen-a" });
  restarted.start({ attachRuntime: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.env.LEAFCODE_PI_BACKEND_RUNTIME, "attach");
  assert.equal(calls[1].options.env.LEAFCODE_PI_BACKEND_GENERATION, "gen-a");
  assert.equal(restarted.status().runtime, "attach");
  assert.equal(children.length, 2);
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

test("a service without a spawn function is refused", () => {
  assert.throws(() => createBackendService({ repoRoot: REPO_ROOT, token: "t" }), /spawn is required/);
});

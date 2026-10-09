import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { autoUpdateRuntimeRequest, createAutoUpdater, createUpdateRepository, runtimeIsIdle } from "./auto-update.js";
import { BACKEND_PROTOCOL_HEADER } from "../../shared/backend-protocol.mjs";

const idleState = { supported: true, busy: false };
function fixture(overrides = {}) {
  let clock = 0;
  const calls = [];
  const candidate = { before: "a".repeat(40), target: "b".repeat(40), branch: "main" };
  const updater = createAutoUpdater({
    now: () => clock, idleMs: 100, checkMs: 100,
    repository: {
      check: async () => { calls.push("check"); return candidate; },
      apply: async () => { calls.push("apply"); return true; },
      verify: async () => { calls.push("verify"); return true; },
    },
    readRuntime: async () => idleState,
    prepareRuntime: async () => { calls.push("prepare"); return { prepared: true }; },
    releaseRuntime: async () => { calls.push("release-runtime"); },
    claim: () => { calls.push("claim"); return true; }, release: () => calls.push("release"),
    restart: async () => { calls.push("restart"); },
    ...overrides,
  });
  return { updater, calls, candidate, time: (value) => { clock = value; } };
}
test("waits for both the idle window and check interval, then renews lease and restarts", async () => {
  const f = fixture();
  f.time(99); await f.updater.tick(); assert.deepEqual(f.calls, []);
  f.time(100); await f.updater.tick();
  assert.deepEqual(f.calls, ["check", "claim", "prepare", "apply", "prepare", "verify", "restart", "release-runtime", "release"]);
});
test("all browser activity resets the shared idle window", async () => {
  const f = fixture(); f.time(90); f.updater.activity(); f.time(100); await f.updater.tick();
  assert.deepEqual(f.calls, []); f.time(190); await f.updater.tick(); assert.ok(f.calls.includes("restart"));
});
for (const state of [null, {}, { taskIds: [] }, { supported: true }, { supported: true, busy: true }, { supported: false, busy: false }]) {
  test(`unknown/busy state cannot trigger fetch or restart: ${JSON.stringify(state)}`, async () => {
    assert.equal(runtimeIsIdle(state), false);
    const f = fixture({ readRuntime: async () => state }); f.time(100); await f.updater.tick(); assert.deepEqual(f.calls, []);
  });
}
test("new input during fetch cancels before claiming or applying", async () => {
  const f = fixture({ repository: { check: async () => { f.updater.activity(); return f.candidate; }, apply: async () => assert.fail("apply") } });
  f.time(100); await f.updater.tick(); assert.deepEqual(f.calls, []);
});
test("new input after apply cancels restart and releases both gates", async () => {
  const f = fixture({ repository: { check: async () => f.candidate, apply: async () => { f.updater.activity(); return true; } } });
  f.time(100); await f.updater.tick(); assert.deepEqual(f.calls, ["claim", "prepare", "release-runtime", "release"]);
});
test("new work between fetch and preparation cancels the handoff", async () => {
  const f = fixture({ prepareRuntime: async () => ({ prepared: false }) });
  f.time(100); await f.updater.tick(); assert.deepEqual(f.calls, ["check", "claim", "release-runtime", "release"]);
});
test("repository edits during the final runtime probe cancel restart", async () => {
  let dirty = false;
  let probes = 0;
  const f = fixture({
    repository: {
      check: async () => f.candidate, apply: async () => true,
      verify: async () => !dirty,
    },
    readRuntime: async () => { if (++probes === 2) dirty = true; return idleState; },
  });
  f.time(100); await f.updater.tick();
  assert.equal(f.calls.includes("restart"), false);
  assert.equal(f.calls.at(-1), "release");
});
test("a slow failed check backs off from completion, not its start", async () => {
  let checks = 0;
  const f = fixture({ repository: { check: async () => { checks++; f.time(1000); throw new Error("offline"); } } });
  f.time(100); await f.updater.tick(); await f.updater.tick();
  assert.equal(checks, 1);
});
test("restart failure releases admission and backs off", async () => {
  const errors = [];
  const f = fixture({ restart: async () => { throw new Error("spawn failed"); }, error: (line) => errors.push(line) });
  f.time(100); await f.updater.tick(); await f.updater.tick();
  assert.equal(f.calls.filter((call) => call === "check").length, 1);
  assert.equal(f.calls.at(-1), "release"); assert.match(errors[0], /spawn failed/);
});
test("concurrent ticks are single flight and other service restarts block", async () => {
  let finish;
  const f = fixture({ readRuntime: () => finish ? Promise.resolve(idleState) : new Promise((resolve) => { finish = resolve; }) });
  f.time(100); const pending = f.updater.tick(); f.time(1000); await f.updater.tick();
  finish(idleState); await pending; assert.equal(f.calls.filter((call) => call === "restart").length, 1);
  const blocked = fixture({ available: () => false }); blocked.time(1000); await blocked.updater.tick(); assert.deepEqual(blocked.calls, []);
});
test("runtime protocol / unavailable responses fail closed, actions use authenticated POST", async () => {
  const options = { baseUrl: "http://owner.test", token: "test" };
  for (const fetchImpl of [async () => { throw new Error("offline"); }, async () => new Response("{}"), async () => new Response("{}", { status: 503 })]) {
    assert.equal(await autoUpdateRuntimeRequest({ ...options, fetchImpl }), null);
  }
  const result = await autoUpdateRuntimeRequest({ ...options, action: "prepare-auto-update", fetchImpl: async (_url, init) => {
    assert.equal(init.method, "POST"); assert.equal(init.headers.authorization, "Bearer test");
    assert.deepEqual(JSON.parse(init.body), { action: "prepare-auto-update" });
    return new Response(JSON.stringify({ result: { prepared: true } }), { headers: { [BACKEND_PROTOCOL_HEADER]: "1" } });
  } });
  assert.deepEqual(result, { prepared: true });
  const snapshot = await autoUpdateRuntimeRequest({ ...options, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).searchParams.get("autoUpdate"), "1");
    assert.equal(init.method, "GET");
    return new Response(JSON.stringify({ autoUpdate: idleState }), { headers: { [BACKEND_PROTOCOL_HEADER]: "1" } });
  } });
  assert.deepEqual(snapshot, idleState);
});

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
test("real Git: clean fast-forward only, dirty/index/untracked/branch races and local activation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "lcp-auto-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), source = join(root, "source"), local = join(root, "local");
  git(root, "init", "--bare", remote); git(root, "clone", remote, source);
  const identity = (dir) => { git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.invalid"); };
  identity(source);
  writeFileSync(join(source, "file"), "first"); git(source, "add", "file"); git(source, "commit", "-m", "first"); git(source, "push", "origin", "HEAD");
  git(root, "clone", remote, local); identity(local);
  const repo = createUpdateRepository(local);
  assert.equal(await repo.check(), null);
  writeFileSync(join(source, "file"), "second"); git(source, "commit", "-am", "second"); git(source, "push", "origin", "HEAD");
  writeFileSync(join(local, "untracked"), "keep"); assert.equal(await repo.check(), null); rmSync(join(local, "untracked"));
  const candidate = await repo.check(); assert.ok(candidate);
  writeFileSync(join(local, "file"), "user edit"); assert.equal(await repo.apply(candidate), false); assert.equal(await repo.check(), null);
  git(local, "add", "file"); assert.equal(await repo.apply(candidate), false);
  // Restore only this disposable test repository's fixture file.
  git(local, "restore", "--staged", "file"); git(local, "restore", "file");
  git(local, "switch", "-c", "other"); assert.equal(await repo.apply(candidate), false); git(local, "switch", candidate.branch);
  assert.equal(await repo.apply(candidate), true); assert.equal(git(local, "rev-parse", "HEAD"), candidate.target);
  assert.equal(await repo.verify(candidate), true);
  writeFileSync(join(local, "late-edit"), "preserve me"); assert.equal(await repo.verify(candidate), false);
  rmSync(join(local, "late-edit"));
  git(local, "switch", "other"); assert.equal(await repo.verify(candidate), false);
  git(local, "switch", candidate.branch); assert.equal(await repo.verify(candidate), true);
  // If user activity cancelled the handoff after merge, the changed local HEAD is still eligible.
  assert.deepEqual(await repo.check(), { before: candidate.target, target: candidate.target, branch: candidate.branch });
  const fresh = createUpdateRepository(local); assert.equal(await fresh.check(), null);
  writeFileSync(join(local, "local"), "local update"); git(local, "add", "local"); git(local, "commit", "-m", "local");
  assert.ok(await fresh.check());
  writeFileSync(join(source, "remote"), "remote update"); git(source, "add", "remote"); git(source, "commit", "-m", "remote"); git(source, "push", "origin", "HEAD");
  assert.equal(await fresh.check(), null, "diverged histories must not auto-merge");
});

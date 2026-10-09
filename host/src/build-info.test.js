import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHostBuildInfo } from "./build-info.js";
import { createLlamaControlServer, closeControlServer, listenControlServer } from "./llama-control-server.js";
import { HOST_BUILD_INFO_HEADER, HOST_BUILD_OPERATION_HEADER, publicHostBuildInfo } from "../../shared/host-build-info-contract.mjs";
const commit = "a".repeat(40), remote = "b".repeat(40), stamp = "2026-10-09T00:00:00Z";
function owner(t, git) {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-host-build-"));
  const role = process.env.LEAFCODE_PI_PROCESS_ROLE; process.env.LEAFCODE_PI_PROCESS_ROLE = "host";
  t.after(() => { if (role === undefined) delete process.env.LEAFCODE_PI_PROCESS_ROLE; else process.env.LEAFCODE_PI_PROCESS_ROLE = role; rmSync(dir, { recursive: true, force: true }); });
  const create = () => createHostBuildInfo({ repoRoot: dir, dataDir: dir, git });
  return { dir, create, ...create() };
}
const metadata = { commit, committedAt: stamp, latestCommit: commit };
function reader(_root, args) {
  return Promise.resolve(args[0] === "log" ? { code: 0, stdout: `${commit}\n${stamp}\n` } : { code: 1, stdout: "" });
}
test("Host preserves current/upstream/ancestor/offline metadata semantics", async t => {
  for (const [target, behind, expected] of [[commit, false, commit], [remote, true, commit], [remote, false, remote], [null, false, commit]]) {
    const f = owner(t, async (_root, args) => args[0] === "log" ? reader(_root, args)
      : args[0] === "rev-parse" ? { code: 0, stdout: "origin/main" }
      : args[0] === "ls-remote" ? { code: target ? 0 : 1, stdout: `${target}\trefs/heads/main` }
      : { code: behind ? 0 : 1, stdout: "" });
    assert.deepEqual(await f.read(), { status: 200, body: { ...metadata, latestCommit: expected } });
  }
});
test("unavailable metadata is nullable and public projection strips capabilities", async t => {
  const f = owner(t, async () => ({ code: 1, stdout: "PRIVATE" }));
  assert.deepEqual(await f.read(), { status: 503, body: { commit: null, committedAt: null, latestCommit: null } });
  assert.deepEqual(publicHostBuildInfo({ ...metadata, token: "PRIVATE" }, 200), metadata);
  assert.equal(publicHostBuildInfo({ ...metadata, commit: "bad" }, 200), null);
  assert.equal(publicHostBuildInfo({ ...metadata, committedAt: "" }, 200), null);
  assert.equal(publicHostBuildInfo({ ...metadata, operation: { id: "a".repeat(36), execution: "complete" } }, 200), null);
  assert.deepEqual(publicHostBuildInfo({ error: "https://user:PRIVATE@remote" }, 500), { error: "HostのGit情報・更新処理を完了できません" });
});
test("Host durably admits fixed ff-only pull once and refuses replay after owner recreation", async t => {
  const calls = [], f = owner(t, async (root, args, timeout) => { calls.push({ root, args, timeout }); return args[0] === "pull" ? { code: 0, stdout: "" } : reader(root, args); });
  const id = randomUUID(), result = await f.update(id);
  assert.equal(result.status, 200); assert.deepEqual(result.body.operation, { id, execution: "complete" });
  assert.deepEqual(calls[0], { root: f.dir, args: ["pull", "--ff-only", "--no-edit"], timeout: 60000 });
  assert.equal((await f.create().update(id)).status, 409);
  assert.equal(calls.filter(c => c.args[0] === "pull").length, 1);
  assert.match(readFileSync(join(f.dir, "host-build-info-command.json"), "utf8"), /complete/);
});
test("uncertain Git update stays uncertain and cannot be replayed", async t => {
  let calls = 0; const f = owner(t, async () => { calls++; return { code: 1, stdout: "PRIVATE" }; }), id = randomUUID();
  const result = await f.update(id); assert.equal(result.status, 500); assert.equal(result.body.operation.execution, "unknown");
  assert.equal((await f.create().update(id)).status, 409); assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});
test("concurrent update IDs cannot start a second Git operation", async t => {
  let release, entered = false; const wait = new Promise(r => release = r), id = randomUUID();
  const f = owner(t, async (root, args) => { if (args[0] !== "pull") return reader(root, args); entered = true; await wait; return { code: 0, stdout: "" }; });
  const first = f.update(id); while (!entered) await delay(1);
  assert.equal((await f.update(id)).body.operation.execution, "unknown");
  assert.equal((await f.update(randomUUID())).body.operation.execution, "not-started");
  release(); assert.equal((await first).status, 200);
});
async function httpFixture(t, handlers) {
  const probe = createServer(); await new Promise(done => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const server = createLlamaControlServer({ controlPort: port, ...handlers });
  await listenControlServer(server, port); t.after(() => closeControlServer(server));
  return `http://127.0.0.1:${server.address().port}/build-info`;
}
const privateHeaders = { host: "127.0.0.1", [HOST_BUILD_INFO_HEADER]: "1" };
test("private Host ingress rejects browser Origin, missing marker, method, ID and oversized body before effects", async t => {
  let calls = 0; const base = await httpFixture(t, { onBuildInfoRead: () => { calls++; return { status: 200, body: metadata }; }, onBuildInfoUpdate: () => { calls++; } });
  for (const [method, headers, body, status] of [["GET", { host: "127.0.0.1" }, undefined, 403], ["GET", { ...privateHeaders, origin: "https://outside.invalid" }, undefined, 403], ["PUT", privateHeaders, undefined, 405], ["POST", privateHeaders, "", 400], ["POST", { ...privateHeaders, [HOST_BUILD_OPERATION_HEADER]: "a".repeat(36) }, "", 400], ["POST", { ...privateHeaders, [HOST_BUILD_OPERATION_HEADER]: randomUUID() }, "x".repeat(513), 413]]) {
    assert.equal((await fetch(base, { method, headers, ...(body !== undefined ? { body } : {}) })).status, status);
  }
  assert.equal(calls, 0); assert.equal((await fetch(base, { headers: privateHeaders })).status, 200); assert.equal(calls, 1);
});
test("Host metadata is independent of Backend readiness and older Host is explicit 501", async t => {
  const base = await httpFixture(t, { onBuildInfoRead: () => ({ status: 200, body: { ...metadata, token: "PRIVATE" } }) });
  const response = await fetch(base, { headers: privateHeaders }); assert.deepEqual(await response.json(), metadata);
  const older = await httpFixture(t, {}); assert.equal((await fetch(older, { headers: privateHeaders })).status, 501);
});
test("accepted Host update finishes after HTTP disconnect and duplicate ID does not repeat it", async t => {
  let release, entered = false, calls = 0; const gate = new Promise(r => release = r);
  const f = owner(t, async (root, args) => { if (args[0] !== "pull") return reader(root, args); calls++; entered = true; await gate; return { code: 0, stdout: "" }; });
  const base = await httpFixture(t, { onBuildInfoUpdate: id => f.update(id) }), id = randomUUID();
  const req = request(base, { method: "POST", headers: { ...privateHeaders, [HOST_BUILD_OPERATION_HEADER]: id } }); req.on("error", () => {}); req.end();
  for (let i = 0; i < 100 && !entered; i++) await delay(5); assert.equal(entered, true); req.destroy(); release();
  for (let i = 0; i < 100; i++) { const ledger = readFileSync(join(f.dir, "host-build-info-command.json"), "utf8"); if (ledger.includes("complete")) break; await delay(5); }
  assert.equal((await fetch(base, { method: "POST", headers: { ...privateHeaders, [HOST_BUILD_OPERATION_HEADER]: id } })).status, 409); assert.equal(calls, 1);
});

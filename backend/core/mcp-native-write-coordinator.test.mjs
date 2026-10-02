import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBackendMcpWriteCoordinator } from "./mcp-native-write-coordinator.mjs";
import { createBackendMcpCredentialAuthority } from "./mcp-native-credential-authority.mjs";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP writer coordinator unavailable" && e.cause === undefined;
const leaseError = (e) => e instanceof Error && e.message === "MCP generation lease unavailable" && e.cause === undefined;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(t, assertProcessOwner = () => undefined) {
  const coordinator = createBackendMcpWriteCoordinator({ assertProcessOwner });
  t.after(async () => { coordinator.dispose(); await coordinator.drain(); });
  return coordinator;
}

test("constructor is inert; accepted FIFO writes synchronously fence old leases and block generation publication", async (t) => {
  let gets = 0, calls = 0;
  const co = createBackendMcpWriteCoordinator({ get assertProcessOwner() { gets++; return () => { calls++; }; } });
  t.after(async () => { co.dispose(); await co.drain(); });
  assert.equal(gets, 1); assert.equal(calls, 0); assert.equal(Object.isFrozen(co), true);
  const old = co.beginGeneration(), hold = deferred(), started = deferred(), order = [];
  let active = 0, max = 0, retained;
  const privateResult = { secret: "private-result" };
  const a = co.runWrite(async (scope) => { retained = scope; assert.equal(Object.isFrozen(scope), true); active++; max = Math.max(max, active); order.push("a-start"); started.resolve(); await hold.promise; scope.assertOwner(); order.push("a-end"); active--; return privateResult; });
  const b = co.runWrite(() => { active++; max = Math.max(max, active); order.push("b"); active--; return 42; });
  assert.throws(old.assertOwner, leaseError);
  assert.throws(() => co.beginGeneration(), safe); assert.throws(() => co.captureLease(), safe);
  await started.promise; assert.deepEqual(order, ["a-start"]); hold.resolve();
  assert.equal(await a, privateResult); assert.equal(await b, 42); await co.drain();
  assert.deepEqual(order, ["a-start", "a-end", "b"]); assert.equal(max, 1);
  assert.throws(retained.assertOwner, safe); assert.throws(() => co.captureLease(), safe);
  co.beginGeneration().assertOwner(); assert.throws(old.assertOwner, leaseError); assert.equal(gets, 1);
});

test("private work failures are sanitized, partial writes are not rolled back, and the queue remains usable", async (t) => {
  const co = fixture(t); const old = co.beginGeneration(); let partial = 0;
  const a = co.runWrite(() => { partial = 1; throw Error("private-config-path-token"); });
  const b = co.runWrite(() => 7);
  await assert.rejects(a, safe); assert.equal(await b, 7); assert.equal(partial, 1);
  await co.drain(); assert.throws(old.assertOwner, leaseError);
  assert.throws(() => co.captureLease(), safe); co.beginGeneration().assertOwner();
});

test("observed process-authority failure cancels previously queued tickets even after restoration", async (t) => {
  let allowed = true, laterCalled = false;
  const co = fixture(t, () => { if (!allowed) throw Error("private-owner"); });
  const old = co.beginGeneration();
  const a = co.runWrite(() => { allowed = false; return 1; });
  const b = co.runWrite(() => { laterCalled = true; });
  await assert.rejects(a, safe); allowed = true;
  await assert.rejects(b, safe); assert.equal(laterCalled, false);
  assert.equal(await co.runWrite(() => 8), 8); await co.drain();
  assert.throws(old.assertOwner, leaseError); co.beginGeneration().assertOwner();
});

test("dispose fences active scoped commits/results, skips queued callbacks and drain waits accepted work", async (t) => {
  const co = fixture(t), hold = deferred(), started = deferred(); let committed = false, queued = false, drained = false;
  const a = co.runWrite(async (scope) => { started.resolve(); await hold.promise; scope.assertOwner(); committed = true; });
  const b = co.runWrite(() => { queued = true; });
  await started.promise;
  co.dispose(); co.dispose();
  const drain = co.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  await assert.rejects(co.runWrite(() => { throw Error("Unexpected future write"); }), safe);
  assert.throws(() => co.beginGeneration(), safe);
  hold.resolve(); await assert.rejects(a, safe); await assert.rejects(b, safe); await drain;
  assert.equal(committed, false); assert.equal(queued, false); assert.equal(drained, true);
});

test("nested async writes/drain cannot deadlock; stale async descendants cannot escape the writer context", async (t) => {
  const co = fixture(t); let nested = false, late;
  assert.equal(await co.runWrite(async () => {
    await Promise.resolve();
    await assert.rejects(co.runWrite(() => { nested = true; }), safe);
    await assert.rejects(co.drain(), safe);
    const d = deferred(); late = d.promise;
    setImmediate(async () => { try { await assert.rejects(co.runWrite(() => { nested = true; }), safe); d.resolve(); } catch (e) { d.resolve(e); } });
    return 42;
  }), 42);
  assert.equal(await late, undefined); assert.equal(nested, false);
  assert.equal(await co.runWrite(() => 9), 9);
});

test("drain snapshots accepted work and is not a freeze against future queue submissions", async (t) => {
  const co = fixture(t), first = deferred(), second = deferred(), started = deferred(); let finished = false;
  const a = co.runWrite(async () => { await first.promise; });
  const snapshot = co.drain();
  const b = co.runWrite(async () => { started.resolve(); await second.promise; finished = true; });
  first.resolve(); await a; await snapshot; await started.promise;
  assert.equal(finished, false); assert.throws(() => co.beginGeneration(), safe);
  second.resolve(); await b; await co.drain(); assert.equal(finished, true);
});

test("invalid requests do not poison a valid generation; explicit synchronous owner contracts reject async/default services", async (t) => {
  for (const options of [undefined, null, [], {}, Object.create({ assertProcessOwner() {} }), { assertProcessOwner: 1 }, { assertProcessOwner() {}, fallback: true }]) {
    assert.throws(() => createBackendMcpWriteCoordinator(options), safe);
  }
  const co = fixture(t), current = co.beginGeneration();
  for (const work of [undefined, null, {}, "private"]) await assert.rejects(co.runWrite(work), safe);
  current.assertOwner();
  for (const assertProcessOwner of [() => true, () => Promise.reject(Error("private-async-process")), () => { throw Error("private-owner"); }]) {
    const invalid = fixture(t, assertProcessOwner);
    await assert.rejects(invalid.runWrite(() => { throw Error("Unexpected write"); }), safe);
    assert.throws(() => invalid.beginGeneration(), safe);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("reentrant process callbacks and ownership loss during awaits cannot publish successful writer results", async (t) => {
  let trigger = false, co;
  co = fixture(t, () => { if (trigger) { trigger = false; co.runWrite(() => { throw Error("Unexpected nested write"); }); } });
  co.beginGeneration(); trigger = true;
  await assert.rejects(co.runWrite(() => { throw Error("Unexpected outer write"); }), safe);
  assert.equal(await co.runWrite(() => 1), 1);
  let allowed = true;
  const other = fixture(t, () => { if (!allowed) throw Error("private-owner-revoked"); });
  const a = other.runWrite(async () => { await Promise.resolve(); allowed = false; return "private-result"; });
  await assert.rejects(a, safe);
});

test("coordinated config ABA invalidates old authority without manual generation fencing and leaves bytes intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-writer-aba-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = "https://example.invalid/mcp", userPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundled.json");
  await writeFile(userPath, JSON.stringify({ mcpServers: { fixture: { url } } })); await writeFile(bundledConfigPath, "{}");
  const original = await readFile(userPath), co = fixture(t), old = co.beginGeneration();
  const prepared = await prepareBackendMcpConfigLoader({ agentDir: root, bundledConfigPath }); assert.equal(prepared.ok, true);
  const identity = { namespace: "mcp__fixture", serverUrl: url };
  const gate = createBackendMcpCredentialAuthority({ agentDir: root, bundledConfigPath, prepared, assertRuntimeOwner: old.assertOwner });
  gate(identity);
  await co.runWrite(async (scope) => { scope.assertOwner(); await writeFile(userPath, "{}"); scope.assertOwner(); await writeFile(userPath, original); });
  assert.deepEqual(await readFile(userPath), original);
  assert.throws(() => gate(identity), (e) => e.message === "MCP credential authority unavailable" && e.cause === undefined);
  const current = co.beginGeneration();
  createBackendMcpCredentialAuthority({ agentDir: root, bundledConfigPath, prepared, assertRuntimeOwner: current.assertOwner })(identity);
});

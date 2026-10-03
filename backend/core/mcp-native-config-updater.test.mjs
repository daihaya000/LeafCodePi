import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createBackendMcpConfigUpdater } from "./mcp-native-config-updater.mjs";
import { createBackendMcpWriteCoordinator } from "./mcp-native-write-coordinator.mjs";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP configuration update unavailable" && e.cause === undefined;
const agentDir = join(tmpdir(), "leafcode-mcp-updater-fixture"), configPath = join(agentDir, "mcp.json"), bundledConfigPath = join(agentDir, "bundled.json");
const entry = () => ({ name: "fixture", config: { url: "https://example.invalid/mcp" }, source: configPath, scope: "global" });
const prepared = () => ({ ok: true, issues: [], sourceSha256: "a".repeat(64), bundledSha256: "b".repeat(64), serverCount: 1,
  loadConfig: () => ({ servers: [entry()], errors: [] }) });
function fixture(t, overrides = {}) {
  const co = createBackendMcpWriteCoordinator({ assertProcessOwner() {} }), lease = co.beginGeneration();
  t.after(async () => { co.dispose(); await co.drain(); });
  const writes = [];
  const options = { agentDir, bundledConfigPath, prepared: prepared(), coordinator: co, assertSnapshotOwner: lease.assertOwner,
    writeConfig: (request, scope) => { scope.assertOwner(); writes.push(request); }, ...overrides };
  return { co, lease, writes, options, updater: createBackendMcpConfigUpdater(options) };
}

test("writeHeaders sends a frozen header-only request, consumes the snapshot and rejects bad names/values", async (t) => {
  const f = fixture(t);
  assert.equal(f.updater.writeHeaders(entry(), { Authorization: "Bearer private-token", "x-fixture": null }), undefined);
  assert.deepEqual(f.writes[0], { configPath, bundledConfigPath, expectedSha256: "a".repeat(64), expectedBundledSha256: "b".repeat(64),
    serverName: "fixture", headers: { Authorization: "Bearer private-token", "x-fixture": null } });
  assert.equal(Object.isFrozen(f.writes[0].headers), true);
  // The entered attempt consumed the snapshot: no second write without reprepare.
  assert.throws(() => f.updater.writeHeaders(entry(), { Authorization: "Bearer other" }), safe);
  assert.equal(f.writes.length, 1);
  for (const headers of [{}, { "bad name": "v" }, { "": "v" }, { "x": 1 }, { "x": "bad\nvalue" }, { "x": "a".repeat(8193) }, null, "Authorization"]) {
    const fresh = fixture(t);
    assert.throws(() => fresh.updater.writeHeaders(entry(), headers), safe);
    assert.equal(fresh.writes.length, 0, "invalid headers never reach the writer");
  }
  // Invalid selectors do not consume the snapshot.
  const selector = fixture(t);
  assert.throws(() => selector.updater.writeHeaders({ ...entry(), name: "unknown" }, { Authorization: "Bearer x" }), safe);
  assert.equal(selector.updater.writeHeaders(entry(), { Authorization: "Bearer x" }), undefined);
  assert.equal(selector.writes.length, 1);
});

test("inert construction captures options/snapshot once; fixed frozen request omits caller configs and consumes the snapshot", async (t) => {
  const f = fixture(t); let gets = 0, loads = 0, roles = 0, calls = 0, retained;
  const options = { ...f.options, prepared: { ...prepared(), loadConfig() { loads++; return { servers: [entry()], errors: [] }; } },
    assertSnapshotOwner() { roles++; f.lease.assertOwner(); }, writeConfig(request, scope) { calls++; retained = scope; scope.assertOwner(); f.writes.push(request); } };
  const getters = Object.fromEntries(Object.keys(options).map((key) => [key, { enumerable: true, get() { gets++; return options[key]; } }]));
  const updater = createBackendMcpConfigUpdater(Object.defineProperties({}, getters));
  assert.equal(gets, 6); assert.equal(loads, 1); assert.equal(roles, 0); assert.equal(calls, 0);
  options.prepared.loadConfig = () => { throw Error("private-mutated-loader"); };
  const caller = entry(); Object.defineProperty(caller, "config", { get() { throw Error("caller secret/command must not be evaluated"); } });
  let enabledGets = 0, exposureGets = 0;
  const patch = { get enabled() { enabledGets++; return false; }, get exposure() { exposureGets++; return "deferred"; } };
  assert.equal(updater(caller, patch), undefined);
  assert.equal(enabledGets, 1); assert.equal(exposureGets, 1); assert.equal(calls, 1); assert.equal(roles, 1);
  assert.deepEqual(f.writes[0], { configPath, bundledConfigPath, expectedSha256: "a".repeat(64), expectedBundledSha256: "b".repeat(64), serverName: "fixture", patch: { enabled: false, exposure: "deferred" } });
  assert.equal(Object.isFrozen(f.writes[0]), true); assert.equal(Object.isFrozen(f.writes[0].patch), true);
  assert.throws(retained.assertOwner, safe); assert.throws(() => updater(entry(), { enabled: true }), safe);
  assert.equal(calls, 1); assert.equal(loads, 1); assert.equal(gets, 6);
});

test("invalid global selectors/settings never enter the coordinator or poison the published snapshot", async (t) => {
  const f = fixture(t);
  for (const value of [null, {}, { ...entry(), source: join(agentDir, "other.json") }, { ...entry(), name: "unknown" }, { ...entry(), scope: "project" }, { ...entry(), scope: "extension" }, { ...entry(), scope: undefined }, Object.create(entry()), { ...entry(), fallback: true }]) {
    assert.throws(() => f.updater(value, { enabled: true }), safe);
  }
  for (const patch of [null, [], {}, { enabled: undefined }, { enabled: "false" }, { exposure: undefined }, { exposure: "invalid" }, { enabled: false, url: "private" }, Object.create({ enabled: false }), { [Symbol("private")]: true }, { get enabled() { throw Error("private-getter"); } }]) {
    assert.throws(() => f.updater(entry(), patch), safe);
  }
  assert.equal(f.writes.length, 0); f.lease.assertOwner(); f.updater(entry(), { enabled: true });
});

test("all SDK exposure values/default settings remain literal and detached; missing-source revision stays explicit", async (t) => {
  for (const exposure of ["codemode", "deferred", "direct", "hidden"]) {
    const f = fixture(t, { prepared: { ...prepared(), sourceSha256: null } });
    const patch = { enabled: true, exposure }; f.updater(entry(), patch); patch.exposure = "hidden"; patch.enabled = false;
    assert.deepEqual(f.writes[0].patch, { enabled: true, exposure }); assert.equal(f.writes[0].expectedSha256, null);
  }
});

test("busy rejection before callback entry is retryable, but observed snapshot failure is permanently fenced", async (t) => {
  const f = fixture(t); let busy = true, allowed = true;
  const updater = createBackendMcpConfigUpdater({ ...f.options, coordinator: { runWriteSync(work) { if (busy) throw Error("private-busy"); f.co.runWriteSync(work); } } });
  assert.throws(() => updater(entry(), { enabled: false }), safe); f.lease.assertOwner(); busy = false;
  updater(entry(), { enabled: false }); assert.equal(f.writes.length, 1);
  const other = fixture(t, { assertSnapshotOwner() { if (!allowed) throw Error("private-snapshot"); } });
  allowed = false; assert.throws(() => other.updater(entry(), { enabled: true }), safe);
  allowed = true; assert.throws(() => other.updater(entry(), { enabled: true }), safe); assert.equal(other.writes.length, 0);
});

test("every entered IO failure consumes the updater and errors/async acknowledgments cannot claim saved success", async (t) => {
  for (const writeConfig of [() => { throw Error("private-file-secret"); }, () => true, () => Promise.reject(Error("private-async-IO"))]) {
    const f = fixture(t, { writeConfig });
    assert.throws(() => f.updater(entry(), { enabled: false }), safe);
    assert.throws(() => f.updater(entry(), { enabled: true }), safe);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("skipped/delayed/repeated coordinator callbacks cannot write late or produce a false synchronous acknowledgment", async (t) => {
  const f = fixture(t); let callback;
  const delayed = createBackendMcpConfigUpdater({ ...f.options, coordinator: { runWriteSync(work) { callback = work; } } });
  assert.throws(() => delayed(entry(), { enabled: false }), safe);
  assert.throws(() => callback({ assertOwner() {} }), safe); assert.equal(f.writes.length, 0);
  const repeated = createBackendMcpConfigUpdater({ ...f.options, coordinator: { runWriteSync(work) { work({ assertOwner() {} }); try { work({ assertOwner() {} }); } catch {} } } });
  assert.throws(() => repeated(entry(), { enabled: true }), safe); assert.equal(f.writes.length, 1);
  const wrong = fixture(t, { coordinator: { runWriteSync() { return true; } } });
  assert.throws(() => wrong.updater(entry(), { enabled: true }), safe); assert.equal(wrong.writes.length, 0);
});

test("malformed snapshots/dependencies are refused without IO; swallowed reentrant snapshot failures cannot succeed", async (t) => {
  const f = fixture(t);
  for (const options of [undefined, {}, { ...f.options, fallback: true }, { ...f.options, agentDir: "relative" }, { ...f.options, bundledConfigPath: configPath }, { ...f.options, writeConfig: async () => {} }, { ...f.options, assertSnapshotOwner: async () => {} }, { ...f.options, coordinator: { runWriteSync: async () => {} } }]) {
    assert.throws(() => createBackendMcpConfigUpdater(options), safe);
  }
  for (const snapshot of [{ ...prepared(), ok: false }, { ...prepared(), sourceSha256: "private" }, { ...prepared(), serverCount: 2 }, { ...prepared(), loadConfig: () => ({ servers: [{ ...entry(), scope: "project" }], errors: [] }) }, { ...prepared(), serverCount: 2, loadConfig: () => ({ servers: [{ ...entry(), name: "a-b" }, { ...entry(), name: "a_b" }], errors: [] }) }]) {
    assert.throws(() => createBackendMcpConfigUpdater({ ...f.options, prepared: snapshot }), safe);
  }
  let updater;
  updater = createBackendMcpConfigUpdater({ ...f.options, assertSnapshotOwner() { try { updater(entry(), { enabled: false }); } catch {} } });
  assert.throws(() => updater(entry(), { enabled: false }), safe); assert.equal(f.writes.length, 0);
});

test("swallowed scope failures and async snapshot guards cannot turn restored authority into saved success", async (t) => {
  let allowed = true;
  const f = fixture(t, { coordinator: { runWriteSync(work) { work({ assertOwner() { if (!allowed) throw Error("private-scope"); } }); } },
    writeConfig(request, scope) { allowed = false; try { scope.assertOwner(); } catch {} allowed = true; } });
  assert.throws(() => f.updater(entry(), { enabled: false }), safe);
  assert.throws(() => f.updater(entry(), { enabled: true }), safe);
  const asyncGuard = fixture(t, { assertSnapshotOwner: () => Promise.reject(Error("private-async-snapshot")) });
  assert.throws(() => asyncGuard.updater(entry(), { enabled: false }), safe);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => asyncGuard.updater(entry(), { enabled: false }), safe);
});

test("real loader revisions and global entries compose with real coordinator; boundary itself changes no file bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-updater-")); t.after(() => rm(root, { recursive: true, force: true }));
  const userPath = join(root, "mcp.json"), bundle = join(root, "bundled.json");
  await writeFile(userPath, JSON.stringify({ mcpServers: { fixture: { command: "never-start", args: ["秘密"], enabled: false } } })); await writeFile(bundle, "{}");
  const before = await readFile(userPath), snapshot = await prepareBackendMcpConfigLoader({ agentDir: root, bundledConfigPath: bundle }); assert.equal(snapshot.ok, true);
  const co = createBackendMcpWriteCoordinator({ assertProcessOwner() {} }), lease = co.beginGeneration(); t.after(async () => { co.dispose(); await co.drain(); });
  let request;
  const updater = createBackendMcpConfigUpdater({ agentDir: root, bundledConfigPath: bundle, prepared: snapshot, coordinator: co, assertSnapshotOwner: lease.assertOwner,
    writeConfig(value, scope) { scope.assertOwner(); request = value; } });
  updater(snapshot.loadConfig().servers[0], { enabled: true, exposure: "codemode" });
  assert.equal(request.expectedSha256, snapshot.sourceSha256); assert.equal(request.expectedBundledSha256, snapshot.bundledSha256);
  assert.deepEqual(await readFile(userPath), before); assert.deepEqual(await readFile(bundle), Buffer.from("{}"));
});

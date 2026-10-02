import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, rm, link, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, mock } from "node:test";
import { createBackendMcpConfigRevisionCheck } from "./mcp-native-config-revision.mjs";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
import { createBackendMcpWriteCoordinator } from "./mcp-native-write-coordinator.mjs";
import { createBackendMcpConfigUpdater } from "./mcp-native-config-updater.mjs";
import { createBackendMcpConfigFileWriter } from "./mcp-native-config-file-writer.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP configuration revision unavailable" && e.cause === undefined;
async function fixture(t, missing = false) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-config-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const userPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json");
  await writeFile(bundledConfigPath, "{}", { mode: 0o600 });
  if (!missing) await writeFile(userPath, JSON.stringify({ mcpServers: { fixture: { command: "never-start", enabled: false } } }), { mode: 0o600 });
  const prepare = () => prepareBackendMcpConfigLoader({ agentDir: root, bundledConfigPath });
  const prepared = await prepare(); assert.equal(prepared.ok, true);
  const options = { agentDir: root, bundledConfigPath, expectedSha256: prepared.sourceSha256, expectedBundledSha256: prepared.bundledSha256, assertRuntimeOwner() {} };
  return { root, userPath, bundledConfigPath, prepared, options, prepare };
}

test("inert strict fixed-source construction captures getters once with no runtime/filesystem IO", async (t) => {
  const f = await fixture(t); t.after(() => mock.restoreAll());
  const stat = mock.method(fs, "lstatSync", () => { throw Error("Unexpected IO"); });
  const runtime = mock.fn(() => { throw Error("Unexpected runtime"); });
  const counts = new Map(), wrapped = {};
  for (const key of Object.keys(f.options)) Object.defineProperty(wrapped, key, { enumerable: true, get() { counts.set(key, (counts.get(key) ?? 0) + 1); return key === "assertRuntimeOwner" ? runtime : f.options[key]; } });
  createBackendMcpConfigRevisionCheck(wrapped);
  for (const value of [undefined, null, [], {}, Object.create(f.options), { ...f.options, agentDir: "relative" }, { ...f.options, bundledConfigPath: f.userPath }, { ...f.options, expectedSha256: "private" }, { ...f.options, expectedBundledSha256: null }, { ...f.options, assertRuntimeOwner: undefined }, { ...f.options, fallback: true }, { ...f.options, [Symbol("private")]: true }]) assert.throws(() => createBackendMcpConfigRevisionCheck(value), safe);
  assert.equal([...counts.values()].every((n) => n === 1), true); assert.equal(stat.mock.callCount(), 0); assert.equal(runtime.mock.callCount(), 0);
});

test("stdio snapshot revisions are read-only, detached from mutable options and independent of OAuth identities", async (t) => {
  const f = await fixture(t), bytes = await readFile(f.userPath); let calls = 0;
  const options = { ...f.options, assertRuntimeOwner() { calls++; } }, check = createBackendMcpConfigRevisionCheck(options);
  options.expectedSha256 = "changed"; options.assertRuntimeOwner = () => { throw Error("private late owner"); };
  check(); check(); assert.equal(calls, 4);
  assert.deepEqual(await readFile(f.userPath), bytes); assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("observed user or bundle changes permanently fence old gates despite restoration; fresh preparation can recover", async (t) => {
  for (const path of ["userPath", "bundledConfigPath"]) {
    const f = await fixture(t), original = await readFile(f[path]), check = createBackendMcpConfigRevisionCheck(f.options);
    await writeFile(f[path], Buffer.concat([original, Buffer.from("\n")])); assert.throws(check, safe);
    await writeFile(f[path], original); assert.throws(check, safe);
    const next = await f.prepare(); assert.equal(next.ok, true);
    createBackendMcpConfigRevisionCheck({ ...f.options, expectedSha256: next.sourceSha256, expectedBundledSha256: next.bundledSha256 })();
  }
});

test("null user revision requires continued absence, and never creates a config file", async (t) => {
  const f = await fixture(t, true), check = createBackendMcpConfigRevisionCheck(f.options);
  check(); assert.deepEqual(await readdir(f.root), ["bundle.json"]);
  await writeFile(f.userPath, "{}"); assert.throws(check, safe);
  await rm(f.userPath); assert.throws(check, safe);
});

test("sync lease failures/thenables/reentrancy are consumed, sanitized and permanently fenced", async (t) => {
  const f = await fixture(t);
  for (const work of [() => true, () => Promise.reject(Error("private async owner")), () => { throw Error("private owner"); }]) {
    let valid = false, calls = 0;
    const check = createBackendMcpConfigRevisionCheck({ ...f.options, assertRuntimeOwner() { calls++; if (!valid) return work(); } });
    assert.throws(check, safe); valid = true; assert.throws(check, safe); assert.equal(calls, 1);
  }
  let check, calls = 0;
  check = createBackendMcpConfigRevisionCheck({ ...f.options, assertRuntimeOwner() { calls++; try { check(); } catch { /* swallowed */ } } });
  assert.throws(check, safe); assert.equal(calls, 1); assert.throws(check, safe);
  let after = 0;
  const late = createBackendMcpConfigRevisionCheck({ ...f.options, assertRuntimeOwner() { if (++after === 2) throw Error("private late lease"); } });
  assert.throws(late, safe); assert.equal(after, 2); assert.throws(late, safe);
  await new Promise((resolve) => setImmediate(resolve));
});

test("nonregular, hardlinked, oversized and read-error sources fail closed without mutations", async (t) => {
  for (const mutate of [async (f) => { await rm(f.userPath); await mkdir(f.userPath); }, async (f) => link(f.userPath, join(f.root, "foreign-link")), async (f) => writeFile(f.userPath, Buffer.alloc(2_097_153))]) {
    const f = await fixture(t), check = createBackendMcpConfigRevisionCheck(f.options); await mutate(f); assert.throws(check, safe);
  }
  const f = await fixture(t), check = createBackendMcpConfigRevisionCheck(f.options); t.after(() => mock.restoreAll());
  const read = mock.method(fs, "readSync", () => { throw Error("private source bytes/path"); });
  assert.throws(check, safe); read.mock.restore(); assert.throws(check, safe);
});

test("real coordinator rejects cooperative ABA; updater/file IO invalidates stdio snapshots and requires fresh revisions/lease", async (t) => {
  const f = await fixture(t), coordinator = createBackendMcpWriteCoordinator({ assertProcessOwner() {} }); t.after(() => coordinator.dispose());
  const original = await readFile(f.userPath), oldLease = coordinator.beginGeneration();
  const old = createBackendMcpConfigRevisionCheck({ ...f.options, assertRuntimeOwner: oldLease.assertOwner }); old();
  coordinator.runWriteSync(() => { fs.writeFileSync(f.userPath, "{}"); fs.writeFileSync(f.userPath, original); return undefined; });
  assert.throws(old, safe); assert.deepEqual(await readFile(f.userPath), original);
  const lease = coordinator.beginGeneration(), check = createBackendMcpConfigRevisionCheck({ ...f.options, assertRuntimeOwner: lease.assertOwner });
  // IO composition fixture only; actual Windows ACL policy is covered in mcp-private-storage.test.mjs.
  const writeConfig = createBackendMcpConfigFileWriter({ agentDir: f.root, bundledConfigPath: f.bundledConfigPath, assertPrivateStorage() {} });
  const update = createBackendMcpConfigUpdater({ agentDir: f.root, bundledConfigPath: f.bundledConfigPath, prepared: f.prepared, coordinator, assertSnapshotOwner: check, writeConfig });
  update(f.prepared.loadConfig().servers[0], { enabled: true });
  assert.throws(check, safe); assert.throws(() => update(f.prepared.loadConfig().servers[0], { enabled: false }));
  const next = await f.prepare(); assert.equal(next.ok, true); assert.notEqual(next.sourceSha256, f.prepared.sourceSha256);
  const nextLease = coordinator.beginGeneration(), nextCheck = createBackendMcpConfigRevisionCheck({ ...f.options, expectedSha256: next.sourceSha256, expectedBundledSha256: next.bundledSha256, assertRuntimeOwner: nextLease.assertOwner });
  nextCheck(); assert.equal(next.loadConfig().servers[0].config.enabled, undefined);
  const rebound = createBackendMcpConfigUpdater({ agentDir: f.root, bundledConfigPath: f.bundledConfigPath, prepared: next, coordinator, assertSnapshotOwner: nextCheck, writeConfig });
  rebound(next.loadConfig().servers[0], { enabled: false });
  assert.throws(nextCheck, safe); assert.equal(JSON.parse(await readFile(f.userPath, "utf8")).mcpServers.fixture.enabled, false);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

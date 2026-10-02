import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP configuration owner unavailable" && e.cause === undefined;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, user = { mcpServers: { fixture: { command: "never-start", enabled: false } } }) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-config-owner-")); fs.chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json");
  await writeFile(bundledConfigPath, "{}", { mode: 0o600 });
  if (user !== null) await writeFile(configPath, JSON.stringify(user), { mode: 0o600 });
  // Composition fixtures inject attestation. Real platform ACL/inheritance tests are separate.
  const options = { agentDir: root, bundledConfigPath, assertProcessOwner() {}, assertPrivateStorage(location) { assert.equal(location.configPath, configPath); } };
  return { root, configPath, bundledConfigPath, options };
}
function owned(t, options) { const owner = createBackendMcpConfigOwner(options); t.after(() => owner.dispose()); return owner; }

test("construction is inert, strict and captures authority/storage/options once", async (t) => {
  const f = await fixture(t); t.after(() => mock.restoreAll());
  const stat = mock.method(fs, "lstatSync", () => { throw Error("Unexpected constructor IO"); });
  const authority = mock.fn(), storage = mock.fn(), counts = new Map(), options = {};
  const values = { ...f.options, assertProcessOwner: authority, assertPrivateStorage: storage };
  for (const key of Object.keys(values)) Object.defineProperty(options, key, { enumerable: true, get() { counts.set(key, (counts.get(key) ?? 0) + 1); return values[key]; } });
  owned(t, options);
  for (const input of [undefined, null, [], {}, Object.create(values), { ...values, agentDir: "relative" }, { ...values, bundledConfigPath: f.configPath }, { ...values, assertPrivateStorage: undefined }, { ...values, assertProcessOwner: async () => {} }, { ...values, assertPrivateStorage: async () => {} }, { ...values, urlVariables: { URL: 42 } }, { ...values, fallback: true }]) assert.throws(() => createBackendMcpConfigOwner(input), safe);
  assert.equal([...counts.values()].every((n) => n === 1), true); assert.equal(stat.mock.callCount(), 0); assert.equal(authority.mock.callCount(), 0); assert.equal(storage.mock.callCount(), 0);
});

test("real synchronous saves close all old callbacks; explicit prepare/rebind restores fresh settings without session IO", async (t) => {
  const f = await fixture(t), owner = owned(t, f.options), before = await readFile(f.configPath);
  const binding = await owner.prepare(); assert.deepEqual(await readFile(f.configPath), before);
  assert.equal(Object.isFrozen(binding), true); assert.equal(Object.isFrozen(binding.prepared), true);
  const changed = binding.loadConfig(); changed.servers[0].config.command = "private altered clone";
  assert.equal(binding.loadConfig().servers[0].config.command, "never-start");
  assert.throws(() => binding.updateConfig(binding.loadConfig().servers[0], { enabled: "bad" }), safe); binding.assertOwner();
  const entry = binding.loadConfig().servers[0]; Object.defineProperty(entry, "config", { enumerable: true, get() { throw Error("Do not evaluate caller config"); } });
  assert.equal(binding.updateConfig(entry, { enabled: true }), undefined);
  for (const action of [binding.assertOwner, binding.loadConfig, binding.prepared.loadConfig, () => binding.updateConfig(entry, { enabled: false })]) assert.throws(action, safe);
  const next = await owner.prepare(); assert.equal(next.loadConfig().servers[0].config.enabled, undefined);
  assert.throws(binding.loadConfig, safe); next.assertOwner();
  next.updateConfig(next.loadConfig().servers[0], { enabled: false });
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).mcpServers.fixture.enabled, false);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("a newer preparation closes the old binding immediately and supersedes in-flight candidates", async (t) => {
  const f = await fixture(t), entered = deferred(); let armed = false;
  const owner = owned(t, { ...f.options, assertPrivateStorage() { if (armed) { armed = false; entered.resolve(); } } });
  const old = await owner.prepare(); armed = true;
  const first = owner.prepare(); assert.throws(old.loadConfig, safe); await entered.promise;
  const second = owner.prepare(); await assert.rejects(first, safe);
  const latest = await second; latest.assertOwner(); assert.equal(latest.loadConfig().servers.length, 1);
});

test("a cooperative writer accepted during preparation prevents stale publication, including ABA byte restoration", async (t) => {
  const f = await fixture(t), entered = deferred(), original = await readFile(f.configPath); let signal = true;
  const owner = owned(t, { ...f.options, assertPrivateStorage() { if (signal) { signal = false; entered.resolve(); } } });
  const preparing = owner.prepare(); await entered.promise;
  const write = owner.runWrite((scope) => { scope.assertOwner(); fs.writeFileSync(f.configPath, "{}"); fs.writeFileSync(f.configPath, original); return "private-result"; });
  await assert.rejects(preparing, safe); assert.equal(await write, "private-result"); await owner.drain();
  const fresh = await owner.prepare(); fresh.assertOwner(); assert.deepEqual(await readFile(f.configPath), original);
});

test("observed revision/storage/process failures close a binding permanently; failed preparation never revives it", async (t) => {
  const f = await fixture(t), original = await readFile(f.configPath); let processValid = true, storageValid = true;
  const owner = owned(t, { ...f.options, assertProcessOwner() { if (!processValid) throw Error("private process"); }, assertPrivateStorage() { if (!storageValid) throw Error("private ACL"); } });
  const first = await owner.prepare(); await writeFile(f.configPath, Buffer.concat([original, Buffer.from("\n")])); assert.throws(first.loadConfig, safe);
  await writeFile(f.configPath, original); assert.throws(first.loadConfig, safe);
  const second = await owner.prepare(); storageValid = false; assert.throws(second.loadConfig, safe); storageValid = true; assert.throws(second.loadConfig, safe);
  const third = await owner.prepare(); processValid = false; assert.throws(third.loadConfig, safe); await assert.rejects(owner.prepare(), safe);
  processValid = true; assert.throws(third.loadConfig, safe); (await owner.prepare()).assertOwner();
});

test("no-op and failed entered IO require fresh preparation, without implicit rollback or automatic rebind", async (t) => {
  const f = await fixture(t), owner = owned(t, f.options), original = await readFile(f.configPath);
  const first = await owner.prepare(); first.updateConfig(first.loadConfig().servers[0], { enabled: false });
  assert.deepEqual(await readFile(f.configPath), original); assert.throws(first.loadConfig, safe);
  const second = await owner.prepare(); t.after(() => mock.restoreAll());
  const rename = mock.method(fs, "renameSync", () => { throw Error("private rename failure"); });
  assert.throws(() => second.updateConfig(second.loadConfig().servers[0], { enabled: true }), safe); rename.mock.restore();
  assert.throws(second.loadConfig, safe); assert.deepEqual(await readFile(f.configPath), original);
  (await owner.prepare()).assertOwner(); assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("missing user files remain absent; invalid loader data/async storage acknowledgments are never bindings", async (t) => {
  const f = await fixture(t, null), owner = owned(t, f.options); assert.equal((await owner.prepare()).loadConfig().servers.length, 0);
  assert.deepEqual(await readdir(f.root), ["bundle.json"]);
  await writeFile(f.configPath, "private invalid JSON"); await assert.rejects(owner.prepare(), safe);
  const g = await fixture(t), asyncStorage = owned(t, { ...g.options, assertPrivateStorage: () => Promise.reject(Error("private async storage")) });
  await assert.rejects(asyncStorage.prepare(), safe); await new Promise((r) => setImmediate(r));
});

test("swallowed private-attestor reentrancy fences a binding without recursively re-reading storage", async (t) => {
  const f = await fixture(t); let binding, reenter = false, calls = 0;
  const owner = owned(t, { ...f.options, assertPrivateStorage() { if (reenter) { calls++; try { binding.assertOwner(); } catch { /* swallowed */ } } } });
  binding = await owner.prepare(); reenter = true;
  assert.throws(binding.loadConfig, safe); assert.equal(calls, 1); assert.throws(binding.loadConfig, safe);
  reenter = false; (await owner.prepare()).assertOwner();
});

test("nested preparation cannot deadlock and terminal disposal fences pending work/bindings while drain still settles", async (t) => {
  const f = await fixture(t), owner = owned(t, f.options), binding = await owner.prepare();
  await assert.rejects(owner.runWrite(async (scope) => { scope.assertOwner(); await owner.prepare(); }), safe);
  assert.throws(binding.loadConfig, safe);
  const entered = deferred(), release = deferred();
  const pending = owner.runWrite(async (scope) => { entered.resolve(); await release.promise; scope.assertOwner(); });
  await entered.promise; owner.dispose(); release.resolve(); await assert.rejects(pending, safe); await owner.drain();
  await assert.rejects(owner.prepare(), safe); await assert.rejects(owner.runWrite(() => 42), safe); assert.throws(binding.loadConfig, safe);
});

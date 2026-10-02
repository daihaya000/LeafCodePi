import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
import { createBackendMcpCredentialAuthority } from "./mcp-native-credential-authority.mjs";
import { createBackendMcpOAuthStatusReader } from "./mcp-native-oauth-status.mjs";
const url = "https://example.invalid/mcp?secret=private-query";
const id = (name = "my_server", endpoint = url) => Object.freeze({ namespace: `mcp__${name}`, serverUrl: endpoint });
const safe = (error) => error instanceof Error && error.message === "MCP credential authority unavailable" && error.cause === undefined;
async function fixture(t, user = { mcpServers: { "my-server": { url, oauth: { clientSecret: "!private-command" } } } }, bundled = { mcpServers: {} }) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-credential-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledConfigPath = join(root, "bundled.json"), userPath = join(root, "mcp.json");
  await writeFile(bundledConfigPath, JSON.stringify(bundled));
  if (user !== null) await writeFile(userPath, JSON.stringify(user));
  const prepared = await prepareBackendMcpConfigLoader({ agentDir: root, bundledConfigPath });
  assert.equal(prepared.ok, true);
  let lease = true, runtimeCalls = 0;
  const options = { agentDir: root, bundledConfigPath, prepared, assertRuntimeOwner() { runtimeCalls++; if (!lease) throw Error("private-runtime-owner"); } };
  return { root, userPath, bundledConfigPath, prepared, options, revoke() { lease = false; }, restore() { lease = true; }, runtimeCalls() { return runtimeCalls; } };
}

test("captures the pure loader snapshot without filesystem/runtime IO; fresh fixed-file assertions do not mutate files", async (t) => {
  const f = await fixture(t);
  const userBytes = await readFile(f.userPath), bundledBytes = await readFile(f.bundledConfigPath);
  t.after(() => mock.restoreAll());
  const hooks = ["lstatSync", "openSync", "readSync", "fstatSync"].map((key) => mock.method(fs, key, () => { throw Error("Unexpected construction IO"); }));
  const gate = createBackendMcpCredentialAuthority(f.options);
  assert.equal(f.runtimeCalls(), 0); assert.equal(hooks.every((hook) => hook.mock.callCount() === 0), true);
  for (const hook of hooks) hook.mock.restore();
  gate(id()); gate(id());
  assert.equal(f.runtimeCalls(), 4);
  assert.deepEqual(await readFile(f.userPath), userBytes); assert.deepEqual(await readFile(f.bundledConfigPath), bundledBytes);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundled.json", "mcp.json"]);
});

test("allows exact OAuth HTTP identities including disabled defaults, never stdio/header/provider auth", async (t) => {
  const f = await fixture(t, { mcpServers: {
    "my-server": { url, enabled: false },
    headers: { url, headers: { aUthOrIzAtIoN: "!private-header-command" } },
    provider: { url, auth: { provider: "fixture" } },
    stdio: { command: "private-command", env: { SECRET: "!private-env-command" } },
  } }, { mcpServers: { imported: { url: "https://example.invalid/default" } } });
  const gate = createBackendMcpCredentialAuthority(f.options);
  gate(id()); gate(id("imported", "https://example.invalid/default"));
  for (const value of [id("headers"), id("provider"), id("stdio"), id("missing"), id("my_server", "https://example.invalid/other")]) {
    assert.throws(() => gate(value), safe);
  }
  gate(id());
  assert.deepEqual((await readdir(f.root)).sort(), ["bundled.json", "mcp.json"]);
});

test("a changed user OR bundled revision permanently fences observed old snapshots, including restoration", async (t) => {
  for (const target of ["userPath", "bundledConfigPath"]) {
    const f = await fixture(t), gate = createBackendMcpCredentialAuthority(f.options);
    const original = await readFile(f[target]);
    gate(id()); await writeFile(f[target], Buffer.concat([original, Buffer.from("\n")]));
    assert.throws(() => gate(id()), safe);
    await writeFile(f[target], original);
    assert.throws(() => gate(id()), safe);
    const next = await prepareBackendMcpConfigLoader({ agentDir: f.root, bundledConfigPath: f.bundledConfigPath });
    createBackendMcpCredentialAuthority({ ...f.options, prepared: next })(id());
  }
});

test("absent user revision stays absent; later creation and missing/corrupt/nonregular bundled input are refused", async (t) => {
  const f = await fixture(t, null, { mcpServers: { "my-server": { url } } });
  const gate = createBackendMcpCredentialAuthority(f.options);
  gate(id()); assert.equal(fs.existsSync(f.userPath), false);
  await writeFile(f.userPath, "{}"); assert.throws(() => gate(id()), safe);
  const g = await fixture(t), removed = createBackendMcpCredentialAuthority(g.options);
  await rm(g.bundledConfigPath); assert.throws(() => removed(id()), safe);
  await mkdir(g.bundledConfigPath); assert.throws(() => createBackendMcpCredentialAuthority(g.options)(id()), safe);
  const h = await fixture(t); await writeFile(h.userPath, "private-bad-json");
  assert.throws(() => createBackendMcpCredentialAuthority(h.options)(id()), safe);
});

test("runtime revocation before or during revision reads is terminal; invalid caller identities do not poison the gate", async (t) => {
  const f = await fixture(t), gate = createBackendMcpCredentialAuthority(f.options);
  for (const invalid of [undefined, null, [], {}, Object.create(id()), { ...id(), secret: "private" }, id("my-server"), id("my_server", "https://EXAMPLE.invalid:443/mcp?secret=private-query")]) {
    assert.throws(() => gate(invalid), safe);
  }
  assert.equal(f.runtimeCalls(), 0); gate(id());
  f.revoke(); assert.throws(() => gate(id()), safe); f.restore(); assert.throws(() => gate(id()), safe);
  const g = await fixture(t); let calls = 0;
  const during = createBackendMcpCredentialAuthority({ ...g.options, assertRuntimeOwner() { if (++calls === 2) throw Error("private-revoked-during-read"); } });
  assert.throws(() => during(id()), safe); assert.equal(calls, 2);
  assert.throws(() => during(id()), safe); assert.equal(calls, 2);
});

test("a swallowed reentrant assertion fences the outer gate without recursively invoking the lease", async (t) => {
  const f = await fixture(t); let gate, calls = 0;
  gate = createBackendMcpCredentialAuthority({ ...f.options, assertRuntimeOwner() {
    if (++calls === 1) { try { gate(id()); } catch { /* Host callback must not undo revocation. */ } }
  } });
  assert.throws(() => gate(id()), safe);
  assert.equal(calls, 1);
  assert.throws(() => gate(id()), safe);
  assert.equal(calls, 1);
});

test("hardlinked/oversized source files and filesystem errors fail closed without private diagnostics", async (t) => {
  const f = await fixture(t), gate = createBackendMcpCredentialAuthority(f.options);
  await link(f.userPath, join(f.root, "other-link")); assert.throws(() => gate(id()), safe);
  const g = await fixture(t), oversized = createBackendMcpCredentialAuthority(g.options);
  await writeFile(g.userPath, Buffer.alloc(2_097_153)); assert.throws(() => oversized(id()), safe);
  const h = await fixture(t), readError = createBackendMcpCredentialAuthority(h.options);
  t.after(() => mock.restoreAll());
  const hook = mock.method(fs, "readSync", () => { throw Error("private-source-path-token"); });
  assert.throws(() => readError(id()), safe); hook.mock.restore();
  assert.throws(() => readError(id()), safe);
});

test("strict paths/snapshots/lease contracts reject failed or project/colliding/async snapshots without authority", async (t) => {
  const f = await fixture(t);
  for (const input of [undefined, null, [], {}, Object.create(f.options), { ...f.options, agentDir: "relative" },
    { ...f.options, bundledConfigPath: f.userPath }, { ...f.options, assertRuntimeOwner: undefined }, { ...f.options, fallback: true },
    { ...f.options, prepared: { ...f.prepared, ok: false } }, { ...f.options, prepared: { ...f.prepared, sourceSha256: "private" } }]) {
    assert.throws(() => createBackendMcpCredentialAuthority(input), safe);
  }
  for (const mutate of [
    (s) => { s.errors.push("private-parse-error"); },
    (s) => { s.servers[0].scope = "project"; },
    (s) => { s.servers[0].source = join(f.root, "project", "mcp.json"); },
    (s) => { s.servers[0].config.url = "https://user:private@example.invalid"; },
    (s) => { s.servers[0].config.headers = []; },
    (s) => { s.servers[0].config.command = "private-command"; },
    (s) => { s.servers.push({ ...s.servers[0], name: "my_server" }); },
  ]) {
    const snapshot = f.prepared.loadConfig(); mutate(snapshot);
    const prepared = { ...f.prepared, serverCount: snapshot.servers.length, loadConfig: () => snapshot };
    assert.throws(() => createBackendMcpCredentialAuthority({ ...f.options, prepared }), safe);
  }
  for (const assertRuntimeOwner of [() => true, () => Promise.reject(Error("private-async-lease"))]) {
    assert.throws(() => createBackendMcpCredentialAuthority({ ...f.options, assertRuntimeOwner })(id()), safe);
  }
  assert.throws(() => createBackendMcpCredentialAuthority({ ...f.options, prepared: { ...f.prepared, loadConfig: () => Promise.reject(Error("private-async-snapshot")) } }), safe);
  await new Promise((resolve) => setImmediate(resolve));
});

test("captures option/snapshot/service getters once, detaches returned config and ignores project discovery", async (t) => {
  const f = await fixture(t), counts = new Map();
  const prepared = Object.fromEntries(Object.keys(f.prepared).map((key) => [key, f.prepared[key]]));
  for (const key of Object.keys(prepared)) Object.defineProperty(prepared, key, { enumerable: true, get() { counts.set(key, (counts.get(key) ?? 0) + 1); return f.prepared[key]; } });
  const optionCounts = new Map();
  const options = { ...f.options, prepared };
  const wrapped = Object.fromEntries(Object.keys(options).map((key) => [key, options[key]]));
  for (const key of Object.keys(wrapped)) Object.defineProperty(wrapped, key, { enumerable: true, get() { optionCounts.set(key, (optionCounts.get(key) ?? 0) + 1); return options[key]; } });
  const gate = createBackendMcpCredentialAuthority(wrapped);
  assert.equal([...optionCounts.values()].every((value) => value === 1), true);
  assert.equal([...counts.values()].every((value) => value === 1), true);
  f.prepared.sourceSha256 = "changed"; f.prepared.loadConfig = () => { throw Error("private-late-callback"); };
  await mkdir(join(f.root, "project", ".pi"), { recursive: true });
  await writeFile(join(f.root, "project", ".pi", "mcp.json"), JSON.stringify({ mcpServers: { injected: { url } } }));
  gate(id()); assert.throws(() => gate(id("injected")), safe);
  assert.equal([...optionCounts.values()].every((value) => value === 1), true);
  assert.equal([...counts.values()].every((value) => value === 1), true);
});

test("OAuth status composes with the configured authority; stale configuration never becomes successful empty metadata", async (t) => {
  const f = await fixture(t), gate = createBackendMcpCredentialAuthority(f.options);
  let reads = 0;
  const owner = { assertOwner: gate, readState() { reads++; return { serverUrl: url, tokens: { access_token: "private-token", token_type: "Bearer" } }; },
    writeState() { throw Error("Unexpected write"); }, removeState() { throw Error("Unexpected removal"); }, withRefreshLock() { throw Error("Unexpected refresh"); } };
  const read = createBackendMcpOAuthStatusReader({ owner, now: () => 1000 });
  assert.equal(read("my-server", url).credentialStatus, "present");
  assert.equal(reads, 1);
  await writeFile(f.userPath, "{}");
  assert.throws(() => read("my-server", url), (e) => e.message === "MCP OAuth status unavailable" && e.cause === undefined);
  assert.equal(reads, 1);
});

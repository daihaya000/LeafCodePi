import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, mock } from "node:test";
import { createBackendMcpConfigFileWriter } from "./mcp-native-config-file-writer.mjs";
import { createBackendMcpConfigUpdater } from "./mcp-native-config-updater.mjs";
import { createBackendMcpWriteCoordinator } from "./mcp-native-write-coordinator.mjs";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP configuration file unavailable" && e.cause === undefined;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const native = () => ({ autoEnableCodemode: false, mcpServers: { fixture: { command: "never-start", args: ["日本語"], enabled: false, exposure: "direct", env: { SECRET: "!never-execute" } }, other: { url: "https://example.invalid", oauth: { clientSecret: "private-fixture" }, enabled: false } } });
const scope = { assertOwner() {} };
async function fixture(t, text = JSON.stringify(native(), null, "\t") + "\n") {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-config-file-"));
  fs.chmodSync(root, 0o700); const path = join(root, "mcp.json"), bundle = join(root, "bundle.json");
  await writeFile(path, text, { mode: 0o600 }); await writeFile(bundle, "{}", { mode: 0o600 });
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { const exit = once(c, "exit"); c.kill(); await exit; }
    await rm(root, { recursive: true, force: true });
  });
  const assertions = [], options = { agentDir: root, bundledConfigPath: bundle, assertPrivateStorage(location) { assertions.push(location); } };
  const request = { configPath: path, bundledConfigPath: bundle, expectedSha256: sha(Buffer.from(text)), expectedBundledSha256: sha(Buffer.from("{}")), serverName: "fixture", patch: { enabled: true, exposure: "codemode" } };
  return { root, path, bundle, options, request, assertions, children, writer: createBackendMcpConfigFileWriter(options) };
}

test("inert fixed-file writer preserves BOM/CRLF/indent/other config; SDK defaults remove keys and all artifacts clean up", async (t) => {
  const text = "\uFEFF" + JSON.stringify(native(), null, "\t").replaceAll("\n", "\r\n") + "\r\n", f = await fixture(t, text);
  assert.equal(f.assertions.length, 0); assert.equal(f.writer(f.request, scope), undefined);
  const output = await readFile(f.path, "utf8"), value = JSON.parse(output.slice(1));
  assert.equal(output.startsWith("\uFEFF"), true); assert.equal(/(?<!\r)\n/.test(output), false); assert.equal(output.includes('\t"'), true);
  const expected = native(); delete expected.mcpServers.fixture.enabled; delete expected.mcpServers.fixture.exposure;
  assert.deepEqual(value, expected); assert.equal(f.assertions.length, 3);
  assert.equal(f.assertions.every(v => Object.isFrozen(v) && v.agentDir === f.root && v.configPath === f.path), true);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.path).mode & 0o7777, 0o600);
});

test("no-op keeps exact bytes/inode; EOF style, hidden exposure and unrelated metadata are retained", async (t) => {
  const doc = native(); doc.metadata = { note: "私有データ" };
  const f = await fixture(t, JSON.stringify(doc)); const original = await readFile(f.path), stat = fs.statSync(f.path);
  f.writer({ ...f.request, patch: { enabled: false, exposure: "direct" } }, scope);
  assert.deepEqual(await readFile(f.path), original); assert.equal(fs.statSync(f.path).ino, stat.ino);
  f.writer({ ...f.request, patch: { exposure: "hidden" } }, scope);
  const after = await readFile(f.path, "utf8"); assert.equal(after.endsWith("\n"), false);
  assert.deepEqual(JSON.parse(after).metadata, doc.metadata); assert.equal(JSON.parse(after).mcpServers.fixture.exposure, "hidden");
});

test("refuses stale hashes/arbitrary paths/missing server/source/invalid patch with no overwrite or artifacts", async (t) => {
  const f = await fixture(t), original = await readFile(f.path);
  for (const r of [{ ...f.request, expectedSha256: null }, { ...f.request, expectedSha256: "c".repeat(64) }, { ...f.request, expectedBundledSha256: "c".repeat(64) }, { ...f.request, configPath: f.bundle }, { ...f.request, serverName: "absent" }, { ...f.request, patch: {} }, { ...f.request, patch: { enabled: true, url: "private" } }]) assert.throws(() => f.writer(r, scope), safe);
  assert.deepEqual(await readFile(f.path), original); assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
  fs.unlinkSync(f.path); assert.throws(() => f.writer(f.request, scope), safe); assert.equal(fs.existsSync(f.path), false);
});

test("mandatory synchronous private storage/authority refusal creates no locks and never changes permissions", async (t) => {
  const f = await fixture(t), original = await readFile(f.path), mode = fs.statSync(f.path).mode;
  for (const options of [{ ...f.options, assertPrivateStorage: undefined }, { ...f.options, agentDir: "relative" }, { ...f.options, bundledConfigPath: f.path }]) assert.throws(() => createBackendMcpConfigFileWriter(options), safe);
  const denied = createBackendMcpConfigFileWriter({ ...f.options, assertPrivateStorage() { throw Error("private-ACL"); } });
  assert.throws(() => denied(f.request, scope), safe);
  assert.throws(() => f.writer(f.request, { assertOwner() { throw Error("private-owner"); } }), safe);
  const asyncCheck = createBackendMcpConfigFileWriter({ ...f.options, assertPrivateStorage: () => Promise.reject(Error("private-async-ACL")) });
  assert.throws(() => asyncCheck(f.request, scope), safe); await new Promise(r => setImmediate(r));
  assert.deepEqual(await readFile(f.path), original); assert.equal(fs.statSync(f.path).mode, mode);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("rejects corrupt/legacy/alias/mixed-newline/nonfinite/oversized documents without migration or data coercion", async (t) => {
  const f = await fixture(t);
  for (const text of ['{"mcpServers":{"fixture":{"command":"x","disabled":true}}}', '{"mcpServers":{"fixture":{"command":"x","exposure":"codemode-deferred"}}}', '{"mcpServers":{"fixture":{"command":"x"}},"metadata":1e400}', '{\r\n"mcpServers": {\n}}', 'private-invalid-json', '{"mcpServers":[]}']) {
    await writeFile(f.path, text, { mode: 0o600 }); const request = { ...f.request, expectedSha256: sha(Buffer.from(text)) };
    assert.throws(() => f.writer(request, scope), safe); assert.equal(await readFile(f.path, "utf8"), text);
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(2_097_153, 32)]) {
    await writeFile(f.path, bytes); assert.throws(() => f.writer({ ...f.request, expectedSha256: sha(bytes) }, scope), safe);
    assert.deepEqual(await readFile(f.path), bytes);
  }
});

test("final revision/private checks reject injected user/bundle changes and clean owned temporary files", async (t) => {
  for (const changed of ["user", "bundle"]) {
    const f = await fixture(t); let calls = 0;
    const writer = createBackendMcpConfigFileWriter({ ...f.options, assertPrivateStorage() { if (++calls === 3) fs.writeFileSync(changed === "user" ? f.path : f.bundle, '{"external":true}'); } });
    assert.throws(() => writer(f.request, scope), safe);
    assert.equal(await readFile(changed === "user" ? f.path : f.bundle, "utf8"), '{"external":true}');
    assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
  }
  const f = await fixture(t); let calls = 0;
  const denied = createBackendMcpConfigFileWriter({ ...f.options, assertPrivateStorage() { if (++calls === 3) throw Error("private-revoked-ACL"); } });
  assert.throws(() => denied(f.request, scope), safe); assert.equal(sha(await readFile(f.path)), f.request.expectedSha256);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("existing foreign lock is retained; rename failure preserves source and cleans only owned artifacts", async (t) => {
  const f = await fixture(t), lock = `${f.path}.native-write.lock`;
  await writeFile(lock, "foreign-lock"); assert.throws(() => f.writer(f.request, scope), safe); assert.equal(await readFile(lock, "utf8"), "foreign-lock"); fs.unlinkSync(lock);
  const rename = mock.method(fs, "renameSync", () => { throw Error("private-rename-path"); });
  try { assert.throws(() => f.writer(f.request, scope), safe); } finally { rename.mock.restore(); }
  assert.equal(sha(await readFile(f.path)), f.request.expectedSha256); assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("hardlinks/nonregular source and private-mode changes are refused; temporary bytes are verified before rename", async (t) => {
  const f = await fixture(t), alias = join(f.root, "alias.json");
  fs.linkSync(f.path, alias); assert.throws(() => f.writer(f.request, scope), safe); fs.unlinkSync(alias);
  if (process.platform !== "win32") {
    fs.chmodSync(f.path, 0o644); assert.throws(() => f.writer(f.request, scope), safe); fs.chmodSync(f.path, 0o600);
  }
  fs.unlinkSync(f.path); fs.mkdirSync(f.path); assert.throws(() => f.writer(f.request, scope), safe); fs.rmdirSync(f.path);
  await writeFile(f.path, JSON.stringify(native(), null, "\t") + "\n", { mode: 0o600 });
  let calls = 0;
  const writer = createBackendMcpConfigFileWriter({ ...f.options, assertPrivateStorage() {
    if (++calls === 3) { const temp = fs.readdirSync(f.root).find(v => v.startsWith(".mcp-config-")); fs.writeFileSync(join(f.root, temp), "private-modified-temp"); }
  } });
  assert.throws(() => writer(f.request, scope), safe); assert.equal(sha(await readFile(f.path)), f.request.expectedSha256);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("post-rename cleanup errors report partial failure; temp open collisions never delete foreign files", async (t) => {
  const f = await fixture(t), unlink = fs.unlinkSync;
  const failure = mock.method(fs, "unlinkSync", (p) => { if (p.endsWith(".native-write.lock")) throw Error("private-cleanup"); return unlink(p); });
  try { assert.throws(() => f.writer(f.request, scope), safe); } finally { failure.mock.restore(); }
  assert.notEqual(sha(await readFile(f.path)), f.request.expectedSha256); assert.equal(JSON.parse(await readFile(f.path, "utf8")).mcpServers.fixture.enabled, undefined);
  const other = await fixture(t), open = fs.openSync; let foreign;
  const collision = mock.method(fs, "openSync", (p, flags, ...args) => {
    if (typeof p === "string" && p.includes(".mcp-config-") && flags === "wx") { foreign = p; fs.writeFileSync(p, "foreign-temp"); const e = Error("private-collision"); e.code = "EEXIST"; throw e; }
    return open(p, flags, ...args);
  });
  try { assert.throws(() => other.writer(other.request, scope), safe); } finally { collision.mock.restore(); }
  assert.equal(await readFile(foreign, "utf8"), "foreign-temp"); assert.equal(sha(await readFile(other.path)), other.request.expectedSha256);
});

test("real loader/updater/coordinator composes with atomic IO; saved document is SDK-preflightable", async (t) => {
  const f = await fixture(t), prepared = await prepareBackendMcpConfigLoader({ agentDir: f.root, bundledConfigPath: f.bundle }); assert.equal(prepared.ok, true);
  const co = createBackendMcpWriteCoordinator({ assertProcessOwner() {} }), lease = co.beginGeneration(); t.after(async () => { co.dispose(); await co.drain(); });
  const updater = createBackendMcpConfigUpdater({ agentDir: f.root, bundledConfigPath: f.bundle, prepared, coordinator: co, assertSnapshotOwner: lease.assertOwner, writeConfig: f.writer });
  updater(prepared.loadConfig().servers.find(v => v.name === "fixture"), f.request.patch);
  const saved = await prepareBackendMcpConfigLoader({ agentDir: f.root, bundledConfigPath: f.bundle }); assert.equal(saved.ok, true);
  assert.notEqual(saved.sourceSha256, prepared.sourceSha256); assert.equal(saved.loadConfig().servers.find(v => v.name === "fixture").config.enabled, undefined);
  assert.throws(() => updater(prepared.loadConfig().servers[0], { enabled: false }));
});

test("two real Node writers using the same expected revision have exactly one winner and no lost/partial update", async (t) => {
  const f = await fixture(t), worker = join(f.root, "worker.mjs");
  await writeFile(worker, `import { createBackendMcpConfigFileWriter } from ${JSON.stringify(new URL("./mcp-native-config-file-writer.mjs", import.meta.url).href)};
process.send({ready:true}); process.once('message', r => { let ok=false; try { createBackendMcpConfigFileWriter({agentDir:r.root,bundledConfigPath:r.request.bundledConfigPath,assertPrivateStorage(){}})(r.request,{assertOwner(){}});ok=true;}catch{} process.send({ok},()=>process.disconnect()); });`);
  const runs = [0, 1].map(() => { const c = fork(worker, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); f.children.push(c); return { c, ready: once(c, "message"), exit: once(c, "exit") }; });
  const children = runs.map(r => r.c), exits = runs.map(r => r.exit); await Promise.all(runs.map(r => r.ready));
  const results = children.map(c => once(c, "message")); children.forEach(c => c.send({ root: f.root, request: f.request }));
  const messages = await Promise.all(results); assert.equal(messages.filter(([m]) => m.ok).length, 1); await Promise.all(exits);
  const value = JSON.parse(await readFile(f.path, "utf8")); assert.equal(value.mcpServers.fixture.enabled, undefined);
  assert.equal(value.mcpServers.fixture.exposure, undefined); assert.deepEqual(value.mcpServers.other, native().mcpServers.other);
  assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json", "worker.mjs"]);
});

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { createBackendMcpCredentialOwner } from "./mcp-native-credential-owner.mjs";

const url = "https://example.invalid/mcp";
const id = Object.freeze({ namespace: "mcp__fixture", serverUrl: url });
const key = `${id.namespace}|${url}`;
const state = () => ({ serverUrl: url, tokens: { access_token: "private-token", token_type: "Bearer", refresh_token: "private-refresh" },
  clientInformation: { client_id: "fixture", client_secret: "private-client", client_name: "日本語" }, codeVerifier: "private-verifier" });
const safe = (error) => error instanceof Error && error.message === "MCP credential store unavailable" && error.cause === undefined;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-credential-owner-"));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  let owned = true, privateStorage = true;
  const assertions = [];
  const options = { agentDir: root, assertOwner: (identity) => { if (!owned) throw Error("private-owner"); },
    assertPrivateStorage: (location) => { assertions.push(location); if (!privateStorage) throw Error("private-ACL"); } };
  return { root, path: join(root, "mcp-auth.json"), options, assertions, children,
    revoke: () => { owned = false; }, denyPrivate: () => { privateStorage = false; } };
}

test("fixed owner path, no construction IO, missing read/removal no-op, private SDK-compatible state roundtrip", async (t) => {
  const { root, path, options, assertions } = await fixture(t);
  const owner = createBackendMcpCredentialOwner(options);
  assert.deepEqual(assertions, []);
  assert.deepEqual(await readdir(root), []);
  const credentials = createBackendMcpCredentials(owner), store = credentials.forServer("fixture", url);
  assert.equal(store.load(), undefined);
  assert.equal(credentials.remove("fixture", url), false);
  assert.deepEqual(await readdir(root), []);
  store.save(state());
  assert.deepEqual(store.load(), state());
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { [key]: state() });
  const loaded = owner.readState(id); loaded.tokens.access_token = "changed";
  assert.deepEqual(owner.readState(id), state());
  assert.equal(assertions.every((location) => Object.isFrozen(location) && location.agentDir === root && location.credentialPath === path), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(owner), "{}");
});

test("preserves BOM/CRLF/Japanese/other identities and legacy keys without URL-only takeover", async (t) => {
  const { root, path, options } = await fixture(t);
  const other = { namespace: "mcp__other", serverUrl: url };
  const original = { [url]: state(), [`${other.namespace}|${url}`]: state(), __proto_data: { text: "日本語" } };
  await writeFile(path, "\uFEFF" + JSON.stringify(original, null, "\t").replaceAll("\n", "\r\n") + "\r\n", { mode: 0o600 });
  const owner = createBackendMcpCredentialOwner(options);
  assert.equal(owner.readState(id), undefined);
  assert.equal(owner.removeState(id), false);
  owner.writeState(id, state());
  const text = await readFile(path, "utf8");
  assert.equal(text.startsWith("\uFEFF"), true);
  assert.equal(/(?<!\r)\n/.test(text), false);
  assert.equal(text.includes("\t\""), true);
  assert.deepEqual(JSON.parse(text.slice(1)), { ...original, [key]: state() });
  assert.equal(owner.removeState(id), true);
  assert.equal(owner.removeState(id), false);
  assert.deepEqual(JSON.parse((await readFile(path, "utf8")).slice(1)), original);
  assert.deepEqual(await readdir(root), ["mcp-auth.json"]);
});

test("requires synchronous owner/private-storage attestation; revoked authority creates no locks/files", async (t) => {
  const f = await fixture(t);
  for (const options of [null, [], {}, Object.create(f.options), { ...f.options, agentDir: "relative" },
    { ...f.options, credentialPath: "private-path" }, { ...f.options, assertPrivateStorage: undefined }]) {
    assert.throws(() => createBackendMcpCredentialOwner(options), safe);
  }
  const denied = createBackendMcpCredentialOwner(f.options);
  f.denyPrivate();
  assert.throws(() => denied.readState(id), safe);
  assert.throws(() => denied.writeState(id, state()), safe);
  assert.throws(() => denied.removeState(id), safe);
  await assert.rejects(denied.withRefreshLock(id, async () => "not-run"), safe);
  assert.deepEqual(await readdir(f.root), []);
  const asyncGuard = createBackendMcpCredentialOwner({ ...f.options, assertOwner: () => Promise.reject(Error("private-guard")) });
  assert.throws(() => asyncGuard.readState(id), safe);
  await sleep(0);
  f.revoke();
  assert.throws(() => denied.assertOwner(id), safe);
});

test("rejects corrupt/nonregular/private-mode inputs without overwriting or secret errors", async (t) => {
  const { root, path, options } = await fixture(t);
  const owner = createBackendMcpCredentialOwner(options);
  for (const bytes of [Buffer.from("private-invalid-json"), Buffer.from([0xff, 0xfe]), Buffer.from("[]"), Buffer.from("{\r\n\"a\": 1\n}")]) {
    await writeFile(path, bytes, { mode: 0o600 });
    for (const operation of [() => owner.readState(id), () => owner.writeState(id, state()), () => owner.removeState(id)]) assert.throws(operation, safe);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(root), ["mcp-auth.json"]);
  }
  await rm(path);
  await mkdir(path);
  assert.throws(() => owner.writeState(id, state()), safe);
  await rm(path, { recursive: true });
  const outside = join(root, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  fs.linkSync(outside, path); // Temporary hard link: portable on Windows without symlink privileges.
  assert.throws(() => owner.readState(id), safe);
  assert.equal(await readFile(outside, "utf8"), "{}");
  await rm(path);
  if (process.platform !== "win32") {
    await writeFile(path, "{}", { mode: 0o644 });
    assert.throws(() => owner.readState(id), safe);
  }
});

test("atomic failure/source-change checks retain original/external bytes and clean owned transients", async (t) => {
  const f = await fixture(t), owner = createBackendMcpCredentialOwner(f.options);
  t.after(() => mock.restoreAll());
  owner.writeState(id, state());
  const original = await readFile(f.path);
  const rename = fs.renameSync;
  const failure = mock.method(fs, "renameSync", () => { throw Error("private-rename-path"); });
  assert.throws(() => owner.removeState(id), safe);
  failure.mock.restore();
  assert.deepEqual(await readFile(f.path), original);
  assert.deepEqual(await readdir(f.root), ["mcp-auth.json"]);
  const sync = fs.fsyncSync;
  const external = Buffer.from(JSON.stringify({ external: { text: "private-external" } }));
  const changed = mock.method(fs, "fsyncSync", (fd) => { sync(fd); fs.writeFileSync(f.path, external); });
  assert.throws(() => owner.writeState(id, state()), safe);
  changed.mock.restore();
  assert.deepEqual(await readFile(f.path), external);
  assert.deepEqual(await readdir(f.root), ["mcp-auth.json"]);
  assert.equal(fs.renameSync, rename);
});

test("SDK file-lock protocol excludes owner RMW; refresh work errors retain identity; locks release", async (t) => {
  const { root, path, options } = await fixture(t), owner = createBackendMcpCredentialOwner(options);
  owner.writeState(id, state());
  const release = lockfile.lockSync(path, { realpath: false });
  try { assert.throws(() => owner.writeState(id, state()), safe); assert.throws(() => owner.removeState(id), safe); }
  finally { release(); }
  const expected = new Error("SDK-work-error");
  await assert.rejects(owner.withRefreshLock(id, async () => { throw expected; }), (error) => error === expected);
  assert.equal(await owner.withRefreshLock(id, async () => 42), 42);
  assert.deepEqual(await readdir(root), ["mcp-auth.json"]);
});

test("invalid identities/non-JSON state reject without creating a credential file", async (t) => {
  const { root, options } = await fixture(t), owner = createBackendMcpCredentialOwner(options);
  for (const input of [null, Object.create(id), { ...id, path: "private" }, { ...id, namespace: "../private" },
    { ...id, serverUrl: "https://EXAMPLE.invalid/mcp" }]) {
    assert.throws(() => owner.writeState(input, state()), safe);
    assert.throws(() => owner.readState(input), safe);
    assert.throws(() => owner.removeState(input), safe);
  }
  for (const data of [{ ...state(), serverUrl: "https://other.invalid" }, { ...state(), metadata: new Map() },
    { ...state(), metadata: new Date() }, { ...state(), tokensExpireAt: NaN }]) assert.throws(() => owner.writeState(id, data), safe);
  assert.deepEqual(await readdir(root), []);
});

test("compromised refresh lease fences storage/work completion and releases owned lock", async (t) => {
  const { root, options } = await fixture(t), owner = createBackendMcpCredentialOwner(options);
  t.after(() => mock.restoreAll());
  let compromised;
  const realLock = lockfile.lock;
  const hook = mock.method(lockfile, "lock", (path, settings) => { compromised = settings.onCompromised; return realLock(path, settings); });
  await assert.rejects(owner.withRefreshLock(id, async () => {
    compromised(Error("private-lock-path"));
    assert.throws(() => owner.writeState(id, state()), safe);
    assert.throws(() => owner.readState(id), safe);
    return 42;
  }), safe);
  hook.mock.restore();
  assert.deepEqual(await readdir(root), []);
  assert.equal(await owner.withRefreshLock(id, async () => "released"), "released");
});

async function worker(root, children) {
  const path = join(root, "worker.mjs");
  const source = `import { createBackendMcpCredentialOwner } from ${JSON.stringify(new URL("./mcp-native-credential-owner.mjs", import.meta.url).href)};
import { setTimeout as sleep } from 'node:timers/promises';
const url = 'https://example.invalid/mcp';
const owner = createBackendMcpCredentialOwner({ agentDir: process.argv[2], assertOwner() {}, assertPrivateStorage() {} });
process.once('message', async ({ mode, name }) => {
  try {
    if (mode === 'refresh') {
      const id = { namespace: 'mcp__fixture', serverUrl: url };
      await owner.withRefreshLock(id, async () => {
        const state = owner.readState(id) ?? { serverUrl: url, counter: 0, trace: [] };
        state.trace.push('start-' + name); owner.writeState(id, state);
        await sleep(100);
        state.counter++; state.trace.push('end-' + name); owner.writeState(id, state);
      });
    } else {
      for (let i = 0; i < 12; i++) {
        owner.writeState({ namespace: 'mcp__' + name + '_' + i, serverUrl: url }, { serverUrl: url, tokens: { access_token: 'private', token_type: 'Bearer' } });
        await sleep(2);
      }
    }
    process.send({ done: true }, () => process.exit(0));
  } catch { process.send({ failed: true }, () => process.exit(1)); }
});
process.send({ ready: true });
`;
  await writeFile(path, source);
  const child = fork(path, [root], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  const messages = [];
  const done = new Promise((resolve, reject) => {
    child.on("message", (message) => { messages.push(message); if (message.done) resolve(); if (message.failed) reject(Error("Worker failed")); });
    child.on("error", reject);
    child.on("exit", (code) => { if (code !== 0) reject(Error("Worker exit failed")); });
  });
  done.catch(() => undefined);
  while (!messages.some((message) => message.ready)) {
    const [message] = await once(child, "message");
    if (message.failed) throw Error("Worker failed before ready");
  }
  return { child, done };
}

test("two real processes serialize refresh/read/rotate/write for the same identity", { timeout: 12_000 }, async (t) => {
  const { root, options, children } = await fixture(t), owner = createBackendMcpCredentialOwner(options);
  const a = await worker(root, children), b = await worker(root, children);
  a.child.send({ mode: "refresh", name: "a" }); b.child.send({ mode: "refresh", name: "b" });
  await Promise.all([a.done, b.done]);
  const final = owner.readState(id);
  assert.equal(final.counter, 2);
  assert.equal([JSON.stringify(["start-a", "end-a", "start-b", "end-b"]), JSON.stringify(["start-b", "end-b", "start-a", "end-a"])].includes(JSON.stringify(final.trace)), true);
  assert.deepEqual((await readdir(root)).sort(), ["mcp-auth.json", "worker.mjs"]);
});

test("two real processes preserve unrelated identities during whole-document RMW", { timeout: 12_000 }, async (t) => {
  const { root, path, children } = await fixture(t);
  const a = await worker(root, children), b = await worker(root, children);
  a.child.send({ mode: "write", name: "a" }); b.child.send({ mode: "write", name: "b" });
  await Promise.all([a.done, b.done]);
  const final = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.keys(final).length, 24);
  for (const name of ["a", "b"]) for (let i = 0; i < 12; i++) assert.equal(final[`mcp__${name}_${i}|${url}`].tokens.access_token, "private");
  assert.deepEqual((await readdir(root)).sort(), ["mcp-auth.json", "worker.mjs"]);
});

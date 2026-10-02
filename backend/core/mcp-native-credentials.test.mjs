import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { McpOAuthAuthorizationRequiredError, McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { prepareBackendMcpExtensions } from "./mcp-native-extensions.mjs";

const url = "https://example.invalid/mcp";
const state = (serverUrl = url) => ({ serverUrl, tokens: { access_token: "private-access", token_type: "Bearer", refresh_token: "private-refresh" },
  tokensExpireAt: 1234, clientInformation: { client_id: "fixture", client_secret: "private-client", redirect_uris: ["http://127.0.0.1/callback"] },
  codeVerifier: "private-verifier", oauthState: "private-state", discovery: { authorizationServerUrl: "https://issuer.invalid" } });
const key = (id) => `${id.namespace}|${id.serverUrl}`;
function memoryOwner() {
  const values = new Map(), locks = new Map(), calls = [];
  let owned = true;
  const owner = {
    assertOwner(id) { calls.push(["owner", id]); if (!owned) throw Error("private-owner-path"); },
    readState(id) { calls.push(["read", id]); return values.get(key(id)); },
    writeState(id, value) { calls.push(["write", id]); values.set(key(id), value); },
    removeState(id) { calls.push(["remove", id]); return values.delete(key(id)); },
    async withRefreshLock(id, work) {
      calls.push(["lock", id]);
      const previous = locks.get(key(id)) ?? Promise.resolve();
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      locks.set(key(id), next);
      await previous;
      try { return await work(); }
      finally { release(); if (locks.get(key(id)) === next) locks.delete(key(id)); }
    },
  };
  return { owner, values, calls, revoke: () => { owned = false; } };
}
const sanitized = (error) => error instanceof Error && error.message === "MCP credential store unavailable" && error.cause === undefined;

test("explicit owner services, no construction IO and detached full OAuth state/tokens", () => {
  const { owner, values, calls } = memoryOwner();
  const credentials = createBackendMcpCredentials(owner);
  assert.deepEqual(calls, []);
  assert.equal(Object.isFrozen(credentials), true);
  const store = credentials.forServer("fixture", url);
  assert.equal(Object.isFrozen(store), true);
  assert.equal(store.load(), undefined);
  const input = state();
  store.save(input);
  input.clientInformation.client_secret = "changed";
  const loaded = store.load();
  assert.deepEqual(loaded, state());
  loaded.tokens.access_token = "changed";
  loaded.discovery.authorizationServerUrl = "changed";
  const tokens = credentials.tokens("fixture", url);
  tokens.refresh_token = "changed";
  assert.deepEqual(store.load(), state());
  assert.deepEqual(values.get(`mcp__fixture|${url}`), state());
  assert.equal(JSON.stringify(credentials), "{}");
  assert.equal(calls.every(([, id]) => Object.isFrozen(id)), true);
});

test("canonical name/URL identity, separate accounts/endpoints and no legacy URL-only takeover", () => {
  const { owner, values } = memoryOwner();
  values.set(url, state());
  const credentials = createBackendMcpCredentials(owner);
  assert.equal(credentials.tokens("fixture", url), undefined);
  assert.equal(credentials.remove("fixture", url), false);
  const a = credentials.forServer("account-a", "https://EXAMPLE.invalid:443/mcp");
  a.save(state());
  assert.deepEqual(credentials.tokens("account_a", url), state().tokens);
  assert.equal(credentials.tokens("other_account", url), undefined);
  assert.equal(credentials.tokens("account-a", `${url}?account=other`), undefined);
  assert.equal(credentials.remove("other_account", url), false);
  assert.equal(credentials.remove("account_a", url), true);
  assert.equal(a.load(), undefined);
  assert.equal(values.has(url), true);
  assert.equal(credentials.remove("account_a", url), false);
  for (const name of ["__proto__", "constructor"]) {
    credentials.forServer(name, url).save(state());
    assert.deepEqual(credentials.tokens(name, url), state().tokens);
  }
});

test("ownership is rechecked after a handle is created, before all IO and refresh work", async () => {
  const { owner, calls, revoke } = memoryOwner();
  const credentials = createBackendMcpCredentials(owner);
  const store = credentials.forServer("fixture", url);
  revoke();
  calls.length = 0;
  for (const operation of [() => store.load(), () => store.save(state()), () => credentials.tokens("fixture", url),
    () => credentials.remove("fixture", url), () => credentials.forServer("fixture", url)]) assert.throws(operation, sanitized);
  let work = 0;
  await assert.rejects(store.withRefreshLock(async () => { work++; }), sanitized);
  assert.equal(work, 0);
  assert.equal(calls.every(([operation]) => operation === "owner"), true);
  const waiting = memoryOwner();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayed = createBackendMcpCredentials({ ...waiting.owner,
    withRefreshLock: async (_id, run) => { await gate; return run(); } }).forServer("fixture", url);
  const pending = delayed.withRefreshLock(async () => { work++; });
  waiting.revoke();
  release();
  await assert.rejects(pending, sanitized);
  assert.equal(work, 0);
});

test("delegates owner refresh locking across independent adapters, preserves results and SDK work errors", async () => {
  const { owner, calls } = memoryOwner();
  const one = createBackendMcpCredentials(owner).forServer("fixture", url);
  const two = createBackendMcpCredentials(owner).forServer("fixture", url);
  const trace = [];
  const first = one.withRefreshLock(async () => { trace.push("one-start"); await new Promise((resolve) => setTimeout(resolve, 10)); trace.push("one-end"); return 42; });
  const second = two.withRefreshLock(async () => { trace.push("two"); return "done"; });
  assert.deepEqual(await Promise.all([first, second]), [42, "done"]);
  assert.deepEqual(trace, ["one-start", "one-end", "two"]);
  const oauthRequired = new McpOAuthAuthorizationRequiredError("Sign in required");
  await assert.rejects(one.withRefreshLock(async () => { throw oauthRequired; }), (error) => error === oauthRequired);
  assert.equal(await two.withRefreshLock(async () => "released"), "released");
  assert.equal(calls.filter(([operation]) => operation === "lock").length, 4);
});

test("invalid options/identities/corrupt state fail closed without fallback or private errors", () => {
  const { owner, calls, values } = memoryOwner();
  for (const options of [undefined, null, [], {}, Object.create(owner), { ...owner, path: "private-path" }, { ...owner, readState: false }]) {
    assert.throws(() => createBackendMcpCredentials(options), sanitized);
  }
  const credentials = createBackendMcpCredentials(owner);
  for (const [name, endpoint] of [["", url], ["fixture bad", url], ["fixture", "!private-command"], ["fixture", "file:///private"],
    ["fixture", "https://user:private@example.invalid"], ["fixture", `${url}#private`], ["fixture", `${url}\nprivate`]]) {
    assert.throws(() => credentials.forServer(name, endpoint), sanitized);
    assert.throws(() => credentials.tokens(name, endpoint), sanitized);
    assert.throws(() => credentials.remove(name, endpoint), sanitized);
  }
  assert.deepEqual(calls, []);
  const store = credentials.forServer("fixture", url);
  for (const malformed of [null, [], state("https://other.invalid"), { tokens: state().tokens },
    { serverUrl: url, tokens: { access_token: "private", token_type: "Bearer\r\nprivate" } },
    { serverUrl: url, tokens: Object.create(state().tokens) }, { serverUrl: url, privateFunction: () => {} }]) {
    values.set(`mcp__fixture|${url}`, malformed);
    assert.throws(() => store.load(), sanitized);
    assert.throws(() => credentials.tokens("fixture", url), sanitized);
    assert.throws(() => store.save(malformed), sanitized);
  }
  store.save({ serverUrl: url, tokens: undefined });
  assert.equal(credentials.tokens("fixture", url), undefined);
  assert.throws(() => store.save(undefined), sanitized);
});

test("storage/lock errors and unsupported async IO are sanitized; partial writes are not rolled back", async () => {
  const { owner, values } = memoryOwner();
  const partial = createBackendMcpCredentials({ ...owner, writeState(id, value) { values.set(key(id), value); throw Error("private-path/token"); } });
  assert.throws(() => partial.forServer("fixture", url).save(state()), sanitized);
  assert.deepEqual(values.get(`mcp__fixture|${url}`), state());
  for (const override of [{ readState: () => { throw Error("private-read"); } }, { readState: () => Promise.reject(Error("private-read")) },
    { writeState: () => Promise.reject(Error("private-write")) }, { removeState: () => Promise.reject(Error("private-remove")) },
    { removeState: () => "private-success" }, { assertOwner: () => Promise.reject(Error("private-owner")) }]) {
    const credentials = createBackendMcpCredentials({ ...owner, ...override });
    if (override.assertOwner) { assert.throws(() => credentials.forServer("fixture", url), sanitized); continue; }
    const store = credentials.forServer("fixture", url);
    if (override.readState) { assert.throws(() => store.load(), sanitized); assert.throws(() => credentials.tokens("fixture", url), sanitized); }
    if (override.writeState) assert.throws(() => store.save(state()), sanitized);
    if (override.removeState) assert.throws(() => credentials.remove("fixture", url), sanitized);
  }
  const store = createBackendMcpCredentials({ ...owner, withRefreshLock: async () => { throw Error("private-lock"); } }).forServer("fixture", url);
  await assert.rejects(store.withRefreshLock(async () => "not-run"), sanitized);
  const skipped = createBackendMcpCredentials({ ...owner, withRefreshLock: async () => "private-result" }).forServer("fixture", url);
  await assert.rejects(skipped.withRefreshLock(async () => "not-run"), sanitized);
  await new Promise((resolve) => setImmediate(resolve)); // Rejected unsupported IO must not become unhandled.
});

test("captures owner-service and state getters exactly once; validates the detached identity", () => {
  const { owner } = memoryOwner();
  const reads = {};
  const input = Object.fromEntries(Object.entries(owner).map(([name, fn]) => [name, fn]));
  for (const [name, fn] of Object.entries(owner)) Object.defineProperty(input, name, { enumerable: true, get() {
    reads[name] = (reads[name] ?? 0) + 1;
    return reads[name] === 1 ? fn : undefined;
  } });
  const credentials = createBackendMcpCredentials(input);
  assert.equal(Object.values(reads).every((value) => value === 1), true);
  let stateReads = 0;
  const incoming = { ...state(), get serverUrl() { stateReads++; return stateReads === 1 ? url : "https://other.invalid"; } };
  credentials.forServer("fixture", url).save(incoming);
  assert.equal(stateReads, 1);
  assert.deepEqual(credentials.tokens("fixture", url), state().tokens);
  let loadReads = 0;
  const changing = createBackendMcpCredentials({ ...owner, readState: () => ({ ...state(),
    get serverUrl() { loadReads++; return loadReads === 1 ? url : "https://other.invalid"; } }) });
  assert.equal(changing.forServer("fixture", url).load().serverUrl, url);
  assert.equal(loadReads, 1);
});

test("real public OAuth provider uses injected state without discovery, browser, or network", async () => {
  const { owner, values } = memoryOwner();
  const credentials = createBackendMcpCredentials(owner);
  const provider = new McpOAuthProvider({ serverUrl: url, redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "fixture" }, store: credentials.forServer("fixture", url), onRedirect: () => { throw Error("Unexpected browser"); } });
  await provider.saveClientInformation(state().clientInformation);
  await provider.saveTokens({ ...state().tokens, expires_in: 3600 });
  await provider.saveCodeVerifier("private-verifier");
  await provider.saveDiscoveryState(state().discovery);
  assert.equal(await provider.codeVerifier(), "private-verifier");
  assert.equal(typeof await provider.state(), "string");
  assert.deepEqual(await provider.clientInformation(), state().clientInformation);
  assert.deepEqual(await provider.tokens(), { ...state().tokens, expires_in: 3600 });
  assert.equal(values.get(`mcp__fixture|${url}`).tokensExpireAt > Date.now(), true);
  await provider.invalidateCredentials("tokens");
  assert.equal(credentials.tokens("fixture", url), undefined);
  assert.equal((await provider.clientInformation()).client_secret, "private-client");
  await provider.invalidateCredentials("all");
  assert.deepEqual(credentials.forServer("fixture", url).load(), { serverUrl: url });
});

test("real built-in factories accept the structural store without invoking owner storage or transport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-credentials-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { url } } }));
  await writeFile(bundledConfigPath, JSON.stringify({ mcpServers: {} }));
  const { owner, calls } = memoryOwner();
  const no = () => { throw Error("Unexpected transport/browser/write"); };
  const prepared = await prepareBackendMcpExtensions({ agentDir: root, bundledConfigPath,
    mcp: { credentials: createBackendMcpCredentials(owner), openUrl: no, updateConfig: no, createTransport: no } });
  assert.equal(prepared.ok, true);
  const bytes = await readFile(configPath), files = await readdir(root);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: prepared.factories });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.some((extension) => extension.commands.has("mcp")), true);
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(root), files);
  assert.deepEqual(await readFile(configPath), bytes);
});

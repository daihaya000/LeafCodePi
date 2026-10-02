import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { createBackendMcpCredentialOwner } from "./mcp-native-credential-owner.mjs";
import { createBackendMcpOAuthStatusReader } from "./mcp-native-oauth-status.mjs";
const url = "https://example.invalid/mcp?credential=private-query";
const key = (id) => `${id.namespace}|${id.serverUrl}`;
const token = () => ({ access_token: "private-token", token_type: "Bearer", refresh_token: "private-refresh", id_token: "private-id" });
const state = (extra = {}) => ({ serverUrl: url, tokens: token(), clientInformation: { client_id: "private-client-id", client_secret: "private-client-secret" },
  codeVerifier: "private-verifier", oauthState: "private-oauth-state", discovery: { authorizationServerUrl: "https://private-issuer.invalid" }, ...extra });
const safe = (error) => error instanceof Error && error.message === "MCP OAuth status unavailable" && error.cause === undefined;
function fixture() {
  const values = new Map(), operations = [];
  let allowed = true;
  const owner = {
    assertOwner(id) { operations.push(["assert", id]); if (!allowed) throw Error("private-owner-path"); },
    readState(id) { operations.push(["read", id]); return values.get(key(id)); },
    writeState(id, value) { operations.push(["write", id]); values.set(key(id), value); },
    removeState(id) { operations.push(["remove", id]); return values.delete(key(id)); },
    async withRefreshLock(id, work) { operations.push(["lock", id]); return work(); },
  };
  return { owner, values, operations, revoke() { allowed = false; }, set(value, name = "fixture", endpoint = url) {
    values.set(`mcp__${name.replaceAll("-", "_")}|${new URL(endpoint).href}`, value);
  } };
}
const expected = (credentialStatus, configured = true, name = "fixture") => ({ name, configPath: "", url: "https://example.invalid/mcp",
  authType: "oauth", credentialSource: "oauth", credentialConfigured: configured, credentialStatus });

test("construction does no IO; every fresh read returns only existing public auth metadata", () => {
  const f = fixture(); let clocks = 0;
  const read = createBackendMcpOAuthStatusReader({ owner: f.owner, now: () => { clocks++; return 1000; } });
  assert.equal(f.operations.length, 0); assert.equal(clocks, 0);
  assert.deepEqual(read("fixture", url), expected("missing", false));
  f.set(state());
  const output = read("fixture", url);
  assert.deepEqual(output, expected("present"));
  assert.equal(JSON.stringify(output).includes("private"), false);
  output.credentialStatus = "expired"; output.url = "private-mutated";
  assert.deepEqual(read("fixture", url), expected("present"));
  f.set(state({ tokens: undefined }));
  assert.deepEqual(read("fixture", url), expected("missing", false));
  assert.equal(f.operations.filter(([op]) => op === "read").length, 4);
  assert.equal(f.operations.some(([op]) => ["write", "remove", "lock"].includes(op)), false);
  assert.equal(clocks, 4);
});

test("SDK absolute millisecond expiry uses <= boundary; missing relative anchors and invalid expiry are unknown", () => {
  const f = fixture(), read = createBackendMcpOAuthStatusReader({ owner: f.owner, now: () => 2000 });
  for (const [expiry, status] of [[2001, "present"], [2000, "expired"], [1999, "expired"], [0, "expired"], [-1, "expired"],
    [null, "unknown"], ["2001", "unknown"], [NaN, "unknown"], [Infinity, "unknown"], [Number.MAX_SAFE_INTEGER + 1, "unknown"]]) {
    f.set(state({ tokensExpireAt: expiry })); assert.deepEqual(read("fixture", url), expected(status));
  }
  for (const ttl of [60, 0, -1, "60", NaN]) {
    f.set(state({ tokens: { ...token(), expires_in: ttl } })); assert.deepEqual(read("fixture", url), expected("unknown"));
  }
  f.set(state({ tokens: { ...token(), expires_in: undefined }, tokensExpireAt: undefined }));
  assert.deepEqual(read("fixture", url), expected("present"));
});

test("canonical namespace+URL isolates accounts/endpoints; URL-only legacy state is never taken over", () => {
  const f = fixture(), read = createBackendMcpOAuthStatusReader({ owner: f.owner, now: () => 1 });
  f.set(state(), "my-server");
  assert.deepEqual(read("my_server", url), expected("present", true, "my_server"));
  assert.deepEqual(read("other", url), expected("missing", false, "other"));
  const otherUrl = "https://example.invalid/other";
  assert.equal(read("my-server", otherUrl).credentialStatus, "missing");
  f.values.set(url, state());
  assert.deepEqual(read("legacy", url), expected("missing", false, "legacy"));
  f.set(state());
  assert.deepEqual(read("fixture", "https://EXAMPLE.invalid:443/mcp?credential=private-query"), expected("present"));
  assert.equal(f.operations.every(([, id]) => Object.isFrozen(id)), true);
});

test("revoked owner, malformed state/identity and private service errors never become empty-success metadata", () => {
  const f = fixture(), read = createBackendMcpOAuthStatusReader({ owner: f.owner });
  for (const invalid of [null, [], {}, state({ serverUrl: "https://other.invalid" }), state({ tokens: null }), state({ tokens: { access_token: "private" } })]) {
    f.set(invalid); assert.throws(() => read("fixture", url), safe);
  }
  for (const [name, endpoint] of [["bad.name", url], ["fixture", "https://user:private@example.invalid"], ["fixture", "stdio:private"], ["fixture", `${url}#private`], ["fixture", undefined]]) {
    assert.throws(() => read(name, endpoint), safe);
  }
  f.revoke(); assert.throws(() => read("fixture", url), safe);
  const g = fixture(); g.owner.readState = () => { throw Error("private-storage-path-token"); };
  assert.throws(() => createBackendMcpOAuthStatusReader({ owner: g.owner })("fixture", url), safe);
});

test("owner revoked during a private read or clock callback cannot publish a stale successful snapshot", () => {
  for (const phase of ["read", "clock"]) {
    const f = fixture(); f.set(state());
    const original = f.owner.readState;
    if (phase === "read") f.owner.readState = (id) => { const value = original(id); f.revoke(); return value; };
    const read = createBackendMcpOAuthStatusReader({ owner: f.owner, now: () => { if (phase === "clock") f.revoke(); return 1; } });
    assert.throws(() => read("fixture", url), safe);
    assert.equal(f.operations.filter(([op]) => op === "read").length, 1);
  }
});

test("strict factory contracts capture service/option getters once and validate the synchronous clock", async () => {
  const f = fixture(); const hits = new Map();
  const owner = Object.fromEntries(Object.keys(f.owner).map((key) => [key, f.owner[key]]));
  for (const key of Object.keys(owner)) Object.defineProperty(owner, key, { enumerable: true, get() { hits.set(key, (hits.get(key) ?? 0) + 1); return f.owner[key]; } });
  let ownerReads = 0, clockReads = 0;
  const read = createBackendMcpOAuthStatusReader({ get owner() { ownerReads++; return owner; }, get now() { clockReads++; return () => 1; } });
  assert.equal(ownerReads, 1); assert.equal(clockReads, 1);
  assert.equal([...hits.values()].every((count) => count === 1), true);
  read("fixture", url); read("fixture", url);
  assert.equal([...hits.values()].every((count) => count === 1), true);
  for (const options of [undefined, null, [], {}, Object.create({ owner: f.owner }), { owner: f.owner, fallback: true }, { owner: f.owner, now: 1 }, { owner: {} }]) {
    assert.throws(() => createBackendMcpOAuthStatusReader(options), safe);
  }
  for (const now of [() => "private", () => NaN, () => Infinity, () => -1, () => Number.MAX_SAFE_INTEGER + 1, () => { throw Error("private-clock"); }, () => Promise.reject(Error("private-clock"))]) {
    assert.throws(() => createBackendMcpOAuthStatusReader({ owner: f.owner, now })("fixture", url), safe);
  }
  const asyncOwner = { ...f.owner, readState: () => Promise.reject(Error("private-state")) };
  assert.throws(() => createBackendMcpOAuthStatusReader({ owner: asyncOwner })("fixture", url), safe);
  await new Promise((resolve) => setImmediate(resolve));
});

test("fixed file owner integration preserves credential bytes and cleans its temporary document-read lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-oauth-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialPath = join(root, "mcp-auth.json");
  // Injected fixture-only attestation; actual Windows DACL verification has a separate suite.
  const owner = createBackendMcpCredentialOwner({ agentDir: root, assertOwner(id) { assert.equal(id.namespace, "mcp__fixture"); assert.equal(id.serverUrl, url); },
    assertPrivateStorage(location) { assert.equal(location.agentDir, root); assert.equal(location.credentialPath, credentialPath); } });
  const read = createBackendMcpOAuthStatusReader({ owner, now: () => 1000 });
  assert.deepEqual(read("fixture", url), expected("missing", false));
  assert.deepEqual(await readdir(root), []);
  createBackendMcpCredentials(owner).forServer("fixture", url).save(state({ tokensExpireAt: 999 }));
  const before = await readFile(credentialPath);
  assert.deepEqual(read("fixture", url), expected("expired"));
  assert.deepEqual(await readFile(credentialPath), before);
  assert.deepEqual(await readdir(root), ["mcp-auth.json"]);
});

test("real public OAuth provider saves the exact expiry field/units; status reading never refreshes or mutates", async (t) => {
  const f = fixture(); let now = 1_000_000;
  t.after(() => mock.restoreAll()); mock.method(Date, "now", () => now);
  const credentials = createBackendMcpCredentials(f.owner);
  let redirects = 0;
  const provider = new McpOAuthProvider({ serverUrl: url, redirectUrl: "http://127.0.0.1:8765/callback",
    clientMetadata: { client_name: "fixture" }, store: credentials.forServer("fixture", url), onRedirect() { redirects++; } });
  await provider.saveClientInformation({ client_id: "private-client-id", client_secret: "private-client-secret" });
  await provider.saveCodeVerifier("private-verifier");
  await provider.saveTokens({ ...token(), expires_in: 2 });
  const stored = structuredClone(f.values.get(`mcp__fixture|${url}`));
  assert.equal(stored.tokensExpireAt, 1_002_000);
  f.operations.length = 0;
  const read = createBackendMcpOAuthStatusReader({ owner: f.owner, now: () => now });
  assert.deepEqual(read("fixture", url), expected("present"));
  now = 1_002_000; assert.deepEqual(read("fixture", url), expected("expired"));
  assert.deepEqual(f.values.get(`mcp__fixture|${url}`), stored);
  assert.equal(f.operations.some(([op]) => ["write", "remove", "lock"].includes(op)), false);
  assert.equal(redirects, 0);
});

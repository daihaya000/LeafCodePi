import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createBackendMcpCredentialOwner } from "./mcp-native-credential-owner.mjs";
import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { createBackendMcpNativeRuntime as create } from "./mcp-native-runtime.mjs";
import { resolveBackendMcpNativeSession, setBackendMcpNativeSessionProvider } from "./mcp-native-session.mjs";

afterEach(() => setBackendMcpNativeSessionProvider(undefined));

const safe = (e) => e instanceof Error && e.message === "MCP native runtime unavailable" && e.cause === undefined;
const realBundle = resolve("backend/core/mcp-defaults.json");

// node:test runs after-hooks in registration order: remove the directory only after child cleanup hooks.
const removeRoot = (t, root) => t.after(() => rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
async function fixture(t, servers) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-runtime-")); fs.chmodSync(root, 0o700);
  await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  await writeFile(join(root, "bundle.json"), "{}", { mode: 0o600 });
  return root;
}
const base = (root, extra = {}) => ({
  agentDir: root, bundledConfigPath: join(root, "bundle.json"), homeDir: root, environment: { EXPLICIT: "日本語😀", BASE: "fixed" },
  variables: {}, fetch: async () => { throw Error("No network"); }, openUrl() { throw Error("No browser"); }, assertProcessOwner() {},
  storageChecks: { config() {}, credentials() {} }, ...extra,
});
function harness(result) {
  const tools = new Map(), events = new Map(); let active = [];
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on(name, callback) { events.set(name, callback); },
    getSettings: () => ({}), getMcpServers: () => [], getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names) => { active = names; } };
  return { pi, tools, events, async register() { for (const factory of result.factories) await factory(pi); } };
}
const peer = `import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
lines.on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;
switch(message.method){
case 'initialize':send(message.id,{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});break;
case 'tools/list':send(message.id,{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]});break;
case 'tools/call':send(message.id,{content:[{type:'text',text:JSON.stringify({value:process.env.VALUE,cwd:process.cwd()})}]});break;
default:throw Error('Unexpected fixture request');}});
lines.on('close',()=>process.exit(0));\n`;

test("constructor is inert and refuses malformed, async-owner, missing-service and unknown options without IO", (t) => {
  const root = join(tmpdir(), "private-native-runtime-never-created"); const options = base(root);
  assert.equal(fs.existsSync(root), false); const runtime = create(options); assert.equal(fs.existsSync(root), false); runtime.dispose();
  for (const change of [() => undefined, () => [], (o) => ({ ...o, extra: true }), (o) => ({ ...o, fetch: undefined }), (o) => ({ ...o, openUrl: 1 }),
    (o) => ({ ...o, assertProcessOwner: async () => {} }), (o) => ({ ...o, environment: [] }), (o) => ({ ...o, storageChecks: { config() {} } })]) {
    assert.throws(() => create(change(options)), safe);
  }
  const { openUrl, ...missing } = options; assert.throws(() => create(missing), safe);
});

test("real SDK registers family from the real bundled config; disabled bundled entries never launch or break factories", async (t) => {
  const root = await fixture(t, { user: { command: process.execPath, args: ["--version"] } });
  removeRoot(t, root); const runtime = create(base(root, { bundledConfigPath: realBundle, urlVariables: { N8N_MCP_URL: "https://n8n.example/mcp", SLACK_CLIENT_ID: "fixture" } }));
  t.after(() => runtime.dispose());
  const prepared = await runtime.prepare(), result = prepared.forSession(root);
  assert.equal(result.ok, true); assert.equal(result.factories.length, 3); assert.equal(result.serverCount >= 5, true);
  const h = harness(result); await h.register(); assert.equal(h.events.has("session_start"), true);
  assert.deepEqual(fs.readFileSync(join(root, "mcp.json"), "utf8"), JSON.stringify({ mcpServers: { user: { command: process.execPath, args: ["--version"] } } }));
});

test("full runtime connects a real stdio child with explicit env and exposes the generated tool", async (t) => {
  const root = await fixture(t, {}); const script = join(root, "peer.mjs"); await writeFile(script, peer, { mode: 0o600 });
  await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script], env: { VALUE: "${EXPLICIT}" }, exposure: "direct" } } }), { mode: 0o600 });
  const runtime = create(base(root, { startupWaitMs: 0 }));
  const result = (await runtime.prepare()).forSession(root); assert.equal(result.ok, true);
  const h = harness(result); await h.register();
  const ctx = { cwd: root, mode: "print", modelRegistry: {}, ui: { notify(message) { throw Error(message); } } };
  t.after(async () => { try { await h.events.get("session_shutdown")?.({}, ctx); } finally { runtime.dispose(); } }); removeRoot(t, root);
  h.events.get("session_start")({}, ctx);
  for (const deadline = Date.now() + 8000; !h.tools.has("mcp__fixture__echo"); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > deadline) throw Error("registration timeout");
  const response = await h.tools.get("mcp__fixture__echo").execute("fixture", {}, new AbortController().signal, undefined, {});
  assert.deepEqual(JSON.parse(response.content[0].text), { value: "日本語😀", cwd: root });
});

test("full runtime routes url entries to the HTTP factory with the explicit fetch and mandatory redirect refusal", async (t) => {
  const requests = []; const server = createServer((req, res) => { req.resume(); requests.push(req.headers); res.writeHead(500); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const root = await fixture(t, { remote: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { "X-Fixture": "${TOKEN}" }, exposure: "direct" } });
  const calls = []; const runtime = create(base(root, { variables: { TOKEN: "fixture-token" }, startupWaitMs: 0,
    fetch: async (url, init) => { calls.push({ url: String(url), redirect: init?.redirect, header: new Headers(init?.headers).get("x-fixture") }); return new Response("{}", { status: 500 }); } }));
  t.after(() => runtime.dispose());
  const result = (await runtime.prepare()).forSession(root); assert.equal(result.ok, true);
  const h = harness(result); await h.register();
  const ctx = { cwd: root, mode: "print", modelRegistry: {}, ui: { notify() {} } };
  t.after(async () => { try { await h.events.get("session_shutdown")?.({}, ctx); } finally { runtime.dispose(); } }); removeRoot(t, root);
  h.events.get("session_start")({}, ctx); await new Promise((r) => setTimeout(r, 300));
  assert.equal(requests.length, 0); assert.equal(calls.length >= 1, true); assert.equal(calls[0].redirect, "error"); assert.equal(calls[0].header, "fixture-token");
});

test("reprepare retires the old binding and its session factories; disposed runtime refuses prepare", async (t) => {
  const root = await fixture(t, { user: { command: process.execPath } });
  removeRoot(t, root); const runtime = create(base(root)); const first = await runtime.prepare(); const second = await runtime.prepare();
  assert.throws(() => first.binding.assertOwner()); assert.doesNotThrow(() => second.binding.assertOwner());
  assert.equal(second.forSession(root).ok, true);
  assert.equal(first.forSession(root).ok, false);
  runtime.dispose(); await assert.rejects(runtime.prepare(), safe); assert.throws(() => second.binding.assertOwner());
});

test("a failed prepare says so instead of leaving MCP missing without a reason", async (t) => {
  const root = await fixture(t, { user: { command: process.execPath } });
  removeRoot(t, root); const runtime = create(base(root));
  await runtime.prepare();
  // An unreadable config makes the next prepare fail after the previous binding was retired.
  fs.writeFileSync(join(root, "mcp.json"), "{ not json");
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try { await assert.rejects(runtime.prepare(), safe); } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /prepare failed/);
  // A later successful prepare recovers without any operator action.
  fs.writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { user: { command: process.execPath, args: ["--version"] } } }));
  const recovered = await runtime.prepare(); assert.equal(recovered.forSession(root).ok, true);
  runtime.dispose();
});

test("preparing an OAuth server entry does no credential IO and a retired binding cannot publish", async (t) => {
  const root = await fixture(t, { remote: { url: "https://remote.example/mcp", auth: "oauth" } });
  removeRoot(t, root); const runtime = create(base(root)); t.after(() => runtime.dispose());
  const prepared = await runtime.prepare(); assert.equal(prepared.forSession(root).ok, true);
  await runtime.prepare(); // retire first binding
  assert.equal(prepared.forSession(root).ok, false);
  assert.equal(fs.existsSync(join(root, "mcp-auth.json")), false);
});

test("install() is the only provider path; reload publishes a fresh snapshot and a failed reload fails closed", async (t) => {
  const root = await fixture(t, { alpha: { command: process.execPath, args: ["--version"] } });
  const runtime = create(base(root)); t.after(() => runtime.dispose());
  assert.equal(resolveBackendMcpNativeSession(root).active, false);
  const first = await runtime.install();
  const installed = resolveBackendMcpNativeSession(root);
  assert.equal(installed.active, true); assert.equal(installed.factories.length, 3); assert.deepEqual(installed.issues, []);
  assert.deepEqual(first.binding.loadConfig().servers.map((server) => server.name), ["alpha"]);
  // A source change plus install() republishes: the new snapshot retires the old binding.
  await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: {
    alpha: { command: process.execPath, args: ["--version"] }, beta: { command: process.execPath, args: ["--version"] },
  } }), { mode: 0o600 });
  const second = await runtime.install();
  assert.deepEqual(second.binding.loadConfig().servers.map((server) => server.name), ["alpha", "beta"]);
  const reloaded = resolveBackendMcpNativeSession(root);
  assert.equal(reloaded.active, true); assert.equal(reloaded.factories.length, 3);
  assert.equal(first.forSession(root).ok, false); // the previous binding is retired, not silently reused
  // A malformed source cannot reload: the formerly installed provider stays and now fails closed.
  await writeFile(join(root, "mcp.json"), "{not json", { mode: 0o600 });
  await assert.rejects(runtime.install(), safe);
  const stale = resolveBackendMcpNativeSession(root);
  assert.equal(stale.active, true); assert.equal(stale.factories.length, 0);
  assert.deepEqual(stale.issues, [{ code: "native-extension-binding-failed" }]);
  runtime.dispose(); await assert.rejects(runtime.install(), safe);
});

test("readOAuthStatus reads only this snapshot's configured OAuth entries and never mutates the store", async (t) => {
  const remoteUrl = "https://remote.example/mcp";
  const root = await fixture(t, {
    remote: { url: remoteUrl, auth: "oauth" },
    plain: { url: "https://plain.example/mcp" },
    header: { url: "https://header.example/mcp", headers: { Authorization: "Bearer private-header-token" } },
    local: { command: process.execPath, args: ["--version"] },
  });
  const runtime = create(base(root)); t.after(() => runtime.dispose());
  const prepared = await runtime.prepare();
  // A configured HTTP entry without header/provider auth may be credential-managed; the others are not.
  assert.equal(prepared.readOAuthStatus("plain").credentialStatus, "missing");
  assert.throws(() => prepared.readOAuthStatus("header"), safe);
  assert.throws(() => prepared.readOAuthStatus("local"), safe);
  assert.throws(() => prepared.readOAuthStatus("unknown"), safe);
  assert.throws(() => prepared.readOAuthStatus(""), safe);
  // A permissive fixture store writes the same fixed mcp-auth.json the runtime reads.
  const store = createBackendMcpCredentials(createBackendMcpCredentialOwner({ agentDir: root, assertOwner() {}, assertPrivateStorage() {} }));
  const token = { access_token: "private-token", token_type: "Bearer", refresh_token: "private-refresh" };
  store.forServer("remote", remoteUrl).save({ serverUrl: remoteUrl, tokens: token, tokensExpireAt: Date.now() + 60_000 });
  const before = await readFile(join(root, "mcp-auth.json"));
  const present = prepared.readOAuthStatus("remote");
  assert.equal(present.credentialStatus, "present"); assert.equal(present.authType, "oauth"); assert.equal(present.credentialSource, "oauth");
  assert.equal(present.credentialConfigured, true); assert.equal(present.name, "remote"); assert.equal(present.url, "https://remote.example/mcp");
  assert.equal(JSON.stringify(present).includes("private"), false);
  assert.deepEqual(await readFile(join(root, "mcp-auth.json")), before, "a present-status read must not rewrite the store");
  store.forServer("remote", remoteUrl).save({ serverUrl: remoteUrl, tokens: token, tokensExpireAt: Date.now() - 1_000 });
  const expiredBytes = await readFile(join(root, "mcp-auth.json"));
  assert.equal(prepared.readOAuthStatus("remote").credentialStatus, "expired");
  assert.deepEqual(await readFile(join(root, "mcp-auth.json")), expiredBytes, "an expired-status read must not rewrite the store");
  // A retired binding refuses the read instead of serving a cached snapshot.
  await runtime.prepare();
  assert.throws(() => prepared.readOAuthStatus("remote"), safe);
});

test("envCommands resolves adapter-style secrets into the private snapshot before factories see them", async (t) => {
  const root = await fixture(t, { local: { command: process.execPath, args: ["--version"], env: { KEY: "!print-key", ESCAPED: "!!literal" } } });
  removeRoot(t, root);
  const commands = [];
  const plain = create(base(root)); const resolved = create(base(root, { envCommands: { run: (command) => { commands.push(command); return "resolved-value"; } } }));
  t.after(() => { plain.dispose(); resolved.dispose(); });
  assert.equal((await plain.prepare()).snapshot.servers[0].config.env.KEY, "!print-key");
  assert.deepEqual(commands, [], "no executor means no command runs");
  const prepared = await resolved.prepare();
  assert.deepEqual(prepared.snapshot.servers[0].config.env, { KEY: "resolved-value", ESCAPED: "!literal" });
  assert.deepEqual(commands, ["print-key"]);
  assert.equal(prepared.forSession(root).ok, true, "the resolved entry builds its transport factory");
  prepared.snapshot.servers[0].config.env.KEY = "mutated";
  assert.equal((await resolved.prepare()).snapshot.servers[0].config.env.KEY, "resolved-value", "each prepare resolves its own copy");
});

test("readAuthStatus reflects config headers first and falls back to the OAuth store or none", async (t) => {
  const root = await fixture(t, {
    bearer: { url: "https://bearer.example/mcp", headers: { authorization: "Bearer private-token" } },
    headersOnly: { url: "https://headers.example/mcp", headers: { "x-fixture": "private-value" } },
    oauth: { url: "https://oauth.example/mcp", auth: "oauth" },
    local: { command: process.execPath, args: ["--version"] },
  });
  const runtime = create(base(root)); t.after(() => runtime.dispose());
  const prepared = await runtime.prepare();
  const bearer = prepared.readAuthStatus("bearer");
  assert.equal(bearer.authType, "bearer"); assert.equal(bearer.credentialSource, "config");
  assert.equal(bearer.credentialStatus, "present"); assert.equal(bearer.credentialConfigured, true);
  assert.equal(JSON.stringify(bearer).includes("private"), false);
  const custom = prepared.readAuthStatus("headersOnly");
  assert.equal(custom.authType, "headers"); assert.equal(custom.credentialSource, "config"); assert.equal(custom.credentialStatus, "present");
  assert.equal(prepared.readAuthStatus("oauth").credentialStatus, "missing"); // configured endpoint, empty store
  const none = prepared.readAuthStatus("local");
  assert.equal(none.authType, "none"); assert.equal(none.credentialSource, "none"); assert.equal(none.credentialStatus, "missing");
  assert.throws(() => prepared.readAuthStatus("unknown"), safe);
});

test("writeAuth persists a bounded header, republishes the snapshot and retires the old binding", async (t) => {
  const root = await fixture(t, { remote: { url: "https://remote.example/mcp" } });
  const runtime = create(base(root)); t.after(() => runtime.dispose());
  const before = await runtime.prepare();
  const after = await runtime.writeAuth("remote", { Authorization: "Bearer private-fixture", "x-fixture": "1" });
  const onDisk = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
  assert.deepEqual(onDisk.mcpServers.remote.headers, { Authorization: "Bearer private-fixture", "x-fixture": "1" });
  assert.equal(after.snapshot.servers[0].config.headers.Authorization, "Bearer private-fixture");
  assert.equal(after.readAuthStatus("remote").credentialStatus, "present");
  assert.equal(runtime.binding?.assertOwner, undefined);
  // The previous binding is retired by the entered write (its own sanitized message).
  assert.throws(() => before.binding.assertOwner(), (error) => error instanceof Error && error.message === "MCP configuration owner unavailable" && error.cause === undefined);
  // Removal and unknown servers ride the same guarded path.
  const cleared = await runtime.writeAuth("remote", { Authorization: null, "x-fixture": null });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root, "mcp.json"), "utf8")).mcpServers.remote, "headers"), false);
  assert.equal(cleared.readAuthStatus("remote").credentialStatus, "missing");
  await assert.rejects(runtime.writeAuth("unknown", { Authorization: "Bearer x" }), safe);
  await assert.rejects(runtime.writeAuth("remote", { "bad name": "v" }), safe);
});

test("removeOAuth clears only that endpoint's native store entry and refuses stdio/unknown names", async (t) => {
  const remoteUrl = "https://remote.example/mcp";
  const root = await fixture(t, { remote: { url: remoteUrl, auth: "oauth" }, local: { command: process.execPath, args: ["--version"] } });
  const runtime = create(base(root)); t.after(() => runtime.dispose());
  const prepared = await runtime.prepare();
  assert.throws(() => prepared.removeOAuth("local"), safe);
  assert.throws(() => prepared.removeOAuth("unknown"), safe);
  assert.equal(prepared.removeOAuth("remote"), false, "nothing stored yet");
  const store = createBackendMcpCredentials(createBackendMcpCredentialOwner({ agentDir: root, assertOwner() {}, assertPrivateStorage() {} }));
  store.forServer("remote", remoteUrl).save({ serverUrl: remoteUrl, tokens: { access_token: "private-token", token_type: "Bearer" }, tokensExpireAt: Date.now() + 60_000 });
  assert.equal(prepared.readAuthStatus("remote").credentialStatus, "present");
  assert.equal(prepared.removeOAuth("remote"), true);
  assert.equal(prepared.readAuthStatus("remote").credentialStatus, "missing");
  assert.equal(prepared.removeOAuth("remote"), false);
});

test("a failing process owner or storage attestation makes prepare unavailable without leaking causes", async (t) => {
  const root = await fixture(t, { user: { command: process.execPath } });
  removeRoot(t, root);
  for (const change of [{ assertProcessOwner() { throw Error("private owner"); } }, { storageChecks: { config() { throw Error("private acl"); }, credentials() {} } }]) {
    const runtime = create(base(root, change)); await assert.rejects(runtime.prepare(), safe); runtime.dispose();
  }
});

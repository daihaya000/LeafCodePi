import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createBackendMcpNativeRuntime as create } from "./mcp-native-runtime.mjs";

const safe = (e) => e instanceof Error && e.message === "MCP native runtime unavailable" && e.cause === undefined;
const realBundle = resolve("extensions/leafcode-mcp-adapter/mcp.json");

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

test("preparing an OAuth server entry does no credential IO and a retired binding cannot publish", async (t) => {
  const root = await fixture(t, { remote: { url: "https://remote.example/mcp", auth: "oauth" } });
  removeRoot(t, root); const runtime = create(base(root)); t.after(() => runtime.dispose());
  const prepared = await runtime.prepare(); assert.equal(prepared.forSession(root).ok, true);
  await runtime.prepare(); // retire first binding
  assert.equal(prepared.forSession(root).ok, false);
  assert.equal(fs.existsSync(join(root, "mcp-auth.json")), false);
});

test("a failing process owner or storage attestation makes prepare unavailable without leaking causes", async (t) => {
  const root = await fixture(t, { user: { command: process.execPath } });
  removeRoot(t, root);
  for (const change of [{ assertProcessOwner() { throw Error("private owner"); } }, { storageChecks: { config() { throw Error("private acl"); }, credentials() {} } }]) {
    const runtime = create(base(root, change)); await assert.rejects(runtime.prepare(), safe); runtime.dispose();
  }
});

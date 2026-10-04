import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { McpClient, McpConnectionClosedError, StdioTransport } from "@earendil-works/pi-mcp";
import { createBackendMcpStdioTransportFactory as create } from "./mcp-native-stdio-transport.mjs";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { prepareBackendMcpExtensionsFromBinding as compose } from "./mcp-native-extensions.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP stdio transport unavailable" && e.cause === undefined;
function input() {
  const root = join(tmpdir(), "private-stdio-fixture"), configPath = join(root, "mcp.json");
  const entry = { name: "fixture", source: configPath, scope: "global", config: { command: process.execPath,
    args: ["--version"], env: { VALUE: "prefix ${EXPLICIT}", EMPTY: "" }, exposure: "direct" } };
  return { snapshot: { servers: [entry], errors: [] }, configPath, sessionCwd: root, homeDir: root,
    environment: { EXPLICIT: "日本語", BASE: "captured", PATH: "/fixture/bin" }, assertSnapshotOwner() {} };
}
const call = (factory, options, entry = options.snapshot.servers[0]) => factory(entry, options.sessionCwd, undefined);

test("inert constructor, exact global selector, detached explicit env/home/cwd and immutable launch options", async () => {
  const options = input(); let assertions = 0;
  options.assertSnapshotOwner = () => { assertions++; };
  options.snapshot.servers[0].config.args = ["~/child", "${LITERAL_ARG}", "!literal argument"];
  options.snapshot.servers[0].config.cwd = "~/work";
  const expected = structuredClone(options.snapshot.servers[0]), factory = create(options);
  assert.equal(assertions, 0); options.environment.EXPLICIT = "changed"; options.snapshot.servers[0].config.command = "changed";
  const transport = call(factory, options, expected); assert.equal(transport instanceof StdioTransport, true); assert.equal(transport.pid, undefined);
  assert.equal(assertions, 2); assert.equal(transport.options.command, process.execPath);
  assert.deepEqual(transport.options.args, [join(options.homeDir, "child"), "${LITERAL_ARG}", "!literal argument"]);
  assert.equal(transport.options.cwd, join(options.homeDir, "work")); assert.equal(transport.options.inheritEnv, false);
  assert.deepEqual(transport.options.env, { PATH: "/fixture/bin", VALUE: "prefix 日本語", EMPTY: "" });
  assert.throws(() => { transport.options.env.VALUE = "changed"; }, TypeError);
  assert.throws(() => { transport.options.args.push("changed"); }, TypeError);
  assert.throws(() => { transport.options = {}; }, TypeError);
  await transport.close(); assert.equal(transport.pid, undefined);
  const another = call(factory, options, expected); assert.notEqual(another, transport); await another.close();
});

test("a server cwd may not leave the session directory", async () => {
  for (const cwd of ["..", "../outside", "work/../../outside", join(tmpdir(), "elsewhere")]) {
    const options = input(); options.snapshot.servers[0].config.cwd = cwd;
    assert.throws(() => call(create(options), options), safe, `${cwd} must be refused`);
  }
  // `~` expands to the captured home directory, which is outside the session unless it is the same.
  for (const cwd of ["~", "~/elsewhere"]) {
    const outside = input(); outside.homeDir = join(tmpdir(), "elsewhere-home"); outside.snapshot.servers[0].config.cwd = cwd;
    assert.throws(() => call(create(outside), outside), safe, `${cwd} must be refused`);
    const inside = input(); inside.snapshot.servers[0].config.cwd = cwd;
    const transport = call(create(inside), inside);
    assert.equal(transport.options.cwd, join(inside.homeDir, cwd === "~" ? "" : "elsewhere").replace(/[\\/]$/, ""));
    await transport.close();
  }
  // The session directory itself and any path inside it still launch.
  for (const cwd of [undefined, ".", "work", "work/nested", "work/../work/inner"]) {
    const options = input(); options.snapshot.servers[0].config.cwd = cwd;
    const transport = call(create(options), options);
    assert.equal(transport.options.cwd, resolve(options.sessionCwd, cwd ?? "."));
    await transport.close();
  }
});

test("the session directory may be spelled any way the platform accepts", async () => {
  const root = input().sessionCwd;
  const spellings = {
    "forward slashes": root.split(sep).join("/"),
    "trailing separator": root + sep,
    "dot segments": root + sep + "sub" + sep + "..",
    ...(process.platform === "win32" ? { "another letter case": root.toUpperCase() } : {}),
  };
  for (const [label, sessionCwd] of Object.entries(spellings)) {
    // The same directory under another spelling, and a directory that merely starts with two dots.
    for (const cwd of [undefined, "work", "..hidden"]) {
      const options = input(); options.sessionCwd = sessionCwd; options.snapshot.servers[0].config.cwd = cwd;
      const transport = call(create(options), options);
      assert.equal(transport.options.cwd, resolve(sessionCwd, cwd ?? "."), `${label}: ${cwd}`);
      await transport.close();
    }
    for (const cwd of ["..", "../outside", "sub/../../outside"]) {
      const options = input(); options.sessionCwd = sessionCwd; options.snapshot.servers[0].config.cwd = cwd;
      assert.throws(() => call(create(options), options), safe, `${label}: ${cwd} must be refused`);
    }
  }
});

test("constructor rejects malformed contracts, duplicate namespaces, foreign sources and async authority without IO", () => {
  const base = input(); let calls = 0;
  for (const change of [() => undefined, () => [], (o) => ({ ...o, extra: true }), (o) => ({ ...o, homeDir: "relative" }),
    (o) => ({ ...o, environment: { BAD: 1 } }), (o) => ({ ...o, environment: { "BAD=KEY": "value" } }),
    (o) => ({ ...o, assertSnapshotOwner: async () => { calls++; } }), (o) => ({ ...o, snapshot: { ...o.snapshot, errors: ["private error"] } }),
    (o) => ({ ...o, snapshot: { servers: [{ ...o.snapshot.servers[0], source: "private-other" }], errors: [] } }),
    (o) => ({ ...o, snapshot: { servers: [o.snapshot.servers[0], { ...o.snapshot.servers[0], name: "fixture" }], errors: [] } })]) {
    assert.throws(() => create(change(base)), safe);
  }
  assert.equal(calls, 0);
});

test("unsupported/disabled transports, caller config/cwd/auth changes and env-command references cannot become a launch", () => {
  const options = input(), factory = create(options), entry = options.snapshot.servers[0];
  for (const changed of [{ ...entry, name: "unregistered" }, { ...entry, scope: "extension" }, { ...entry, source: "private-other" },
    { ...entry, config: { ...entry.config, args: ["private wrong args"] } }]) assert.throws(() => call(factory, options, changed), safe);
  assert.throws(() => factory(entry, options.homeDir + "/wrong", undefined), safe);
  assert.throws(() => factory(entry, options.sessionCwd, {}), safe);
  const cases = [{ command: "node" }, { command: "!private-command" }, { command: process.execPath, enabled: false },
    { url: "https://private.example/mcp" }, { command: process.execPath, env: { V: "!never-run-private-command" } },
    { command: process.execPath, env: { V: "${MISSING}" } }, { command: process.execPath, env: { V: "${EMPTY}" } },
    { command: process.execPath, env: { V: "${RECURSIVE}" } }, { command: process.execPath, env: { V: "${invalid-ref}" } },
    { command: process.execPath, env: { V: "$MISSING" } }, { command: process.execPath, env: { V: "$$escape" } },
    { command: process.execPath, env: { V: "$!escape" } },
    { command: process.execPath, args: ["nul\0"] }, { command: process.execPath, cwd: "nul\0" }, { command: process.execPath, unknown: true }];
  if (process.platform === "win32") cases.push({ command: join(options.homeDir, "private.cmd") });
  for (const config of cases) {
    const current = input(); current.environment.EMPTY = ""; current.environment.RECURSIVE = "${NESTED}";
    current.snapshot.servers[0].config = config; assert.throws(() => call(create(current), current), safe);
  }
  const good = call(factory, options); assert.equal(good.pid, undefined); good.close();
});

test("observed authority failure/restoration and reentrant/async acknowledgments permanently fence the factory and existing start", async () => {
  const options = input(); let allowed = true;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revocation"); };
  const factory = create(options), transport = call(factory, options); allowed = false;
  await assert.rejects(transport.start(), safe); allowed = true;
  assert.throws(() => call(factory, options), safe); await assert.rejects(transport.start(), safe); assert.equal(transport.pid, undefined); await transport.close();
  const asyncOptions = input(); asyncOptions.assertSnapshotOwner = () => Promise.reject(Error("private async authority"));
  assert.throws(() => call(create(asyncOptions), asyncOptions), safe); await new Promise((resolve) => setImmediate(resolve));
  const reentrant = input(); let recursive, reenter = false;
  reentrant.assertSnapshotOwner = () => { if (reenter) { try { call(recursive, reentrant); } catch {} } };
  recursive = create(reentrant); reenter = true; assert.throws(() => call(recursive, reentrant), safe);
  reenter = false; assert.throws(() => call(recursive, reentrant), safe);
});

test("only allowlisted names are inherited implicitly, while `${NAME}` still reaches the full snapshot", async () => {
  const options = input();
  options.environment = { "ProgramFiles(x86)": "C:\\Program Files (x86)", HOME: "/home/fixture", LANG: "C.UTF-8",
    npm_config_registry: "https://registry.example/", npm_config__authToken: "npm-secret", NORMAL: "value", SERVICE_TOKEN: "secret" };
  options.snapshot.servers[0].config.env = { VALUE: "${NORMAL}", TOKEN: "${SERVICE_TOKEN}" };
  const transport = call(create(options), options);
  assert.equal(transport.options.env["ProgramFiles(x86)"], "C:\\Program Files (x86)");
  // POSIX spellings and a tooling setting are inherited; the same family's credential is not.
  assert.equal(transport.options.env.HOME, "/home/fixture");
  assert.equal(transport.options.env.LANG, "C.UTF-8");
  assert.equal(transport.options.env.npm_config_registry, "https://registry.example/");
  assert.equal(transport.options.env.npm_config__authToken, undefined);
  assert.equal(transport.options.env.VALUE, "value");
  // Declared explicitly, so the snapshot value is passed on purpose; never inherited implicitly.
  assert.equal(transport.options.env.TOKEN, "secret");
  assert.equal(transport.options.env.SERVICE_TOKEN, undefined);
  assert.equal(transport.options.env.NORMAL, undefined); await transport.close();
  const configEnv = input(); configEnv.snapshot.servers[0].config.env = { "BAD-KEY": "x" };
  assert.throws(() => call(create(configEnv), configEnv), safe);
  const emptyKey = input(); emptyKey.environment = { "": "x" };
  assert.throws(() => call(create(emptyKey), emptyKey), safe);
});

test("env case aliases reject within a Windows map; config overrides the explicit base without duplicate keys", async () => {
  const options = input(); options.environment.PATH = "fixed base"; options.snapshot.servers[0].config.env = { PATH: "fixed override" };
  const transport = call(create(options), options); assert.equal(transport.options.env.PATH, "fixed override"); await transport.close();
  if (process.platform === "win32") {
    assert.throws(() => create({ ...options, environment: { Path: "one", PATH: "two" } }), safe);
    options.environment = { Path: "one" }; options.snapshot.servers[0].config.env = { PATH: "two" };
    const replacement = call(create(options), options); assert.deepEqual(replacement.options.env, { PATH: "two" }); await replacement.close();
  }
});

test("actual spawned process is not rolled back when start completion loses authority; unguarded close releases it", async (t) => {
  const options = input(); options.sessionCwd = tmpdir(); options.snapshot.servers[0].config.args = ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"];
  let checks = 0; options.assertSnapshotOwner = () => { if (++checks === 4) throw Error("private post-spawn revocation"); };
  const transport = call(create(options), options); t.after(() => transport.close());
  await assert.rejects(transport.start(), safe); assert.equal(transport.pid > 0, true);
  assert.throws(() => call(create({ ...options, assertSnapshotOwner: () => { throw Error("private stale owner"); } }), options), safe);
  await transport.close(); await transport.close(); assert.equal(transport.pid, undefined);
});

test("partial stdout completed after revocation suppresses messages and keeps unsubscribe/close usable", async () => {
  const options = input(); let allowed = true, delivered = 0, errors = 0, closed = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  const factory = create(options), transport = call(factory, options);
  const unsubscribe = transport.onMessage(() => { delivered++; });
  const removed = transport.onMessage(() => { throw Error("Unsubscribed callback ran"); }); removed();
  transport.onError((error) => { assert.equal(safe(error), true); errors++; }); transport.onClose(() => { closed++; });
  transport.handleStdout('{"jsonrpc":"2.0","method":"fixture/notification"');
  allowed = false; transport.handleStdout('}\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(delivered, 0); assert.equal(errors, 1); assert.equal(closed, 1); unsubscribe();
  allowed = true; transport.handleStdout('{"jsonrpc":"2.0","method":"fixture/later"}\n');
  assert.equal(delivered, 0); assert.throws(() => call(factory, options), safe);
  await transport.close(); await transport.close(); assert.equal(closed, 1); assert.equal(transport.pid, undefined);
});

test("callback-side revocation preserves its effect but stops remaining listeners and buffered JSON-RPC messages", async () => {
  const options = input(); let allowed = true, first = 0, second = 0, closed = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  const transport = call(create(options), options);
  transport.onMessage(() => { first++; allowed = false; }); transport.onMessage(() => { second++; }); transport.onClose(() => { closed++; });
  transport.handleStdout('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
  assert.equal(first, 1); assert.equal(second, 0); assert.equal(closed, 1); await transport.close();
});

test("healthy parser/callback errors retain native identity and do not poison authority or unsubscribes", async () => {
  const options = input(), factory = create(options), transport = call(factory, options), nativeError = Error("fixture message observer");
  const errors = [], delivered = []; transport.onError((error) => errors.push(error));
  const unsubscribe = transport.onMessage(() => { throw nativeError; });
  transport.handleStdout('{"jsonrpc":"2.0","id":1,"result":{}}\n'); assert.equal(errors[0], nativeError); unsubscribe();
  transport.onMessage((message) => delivered.push(message.id)); transport.handleStdout('invalid fixture JSON\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
  assert.equal(errors[1] instanceof SyntaxError, true); assert.deepEqual(delivered, [2]);
  const another = call(factory, options); let sibling = 0; another.onMessage(() => { sibling++; });
  await transport.close(); another.handleStdout('{"jsonrpc":"2.0","id":3,"result":{}}\n');
  assert.equal(sibling, 1); await another.close();
});

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function within(promise) {
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Stdio fixture timeout")), 4000); timer.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function waitUntil(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() >= deadline) throw Error("Stdio fixture condition timeout"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test("close bounds a server-request drain and reports when its handler never settles", async () => {
  const options = input();
  const transport = call(create(options), options);
  const errors = [];
  transport.onError((error) => errors.push(error));
  transport.onMessage(() => {});
  transport.handleStdout('{"jsonrpc":"2.0","id":"server-request","method":"fixture/slow"}\n');
  const startedAt = Date.now();
  await transport.close();
  assert.equal(Date.now() - startedAt >= 900, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "MCP server request did not settle before stdio close");
});

test("real SDK close drains an incoming async request before child exit and still releases pending calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-stdio-delivery-"));
  const script = join(root, "peer.mjs"), release = join(root, "release"), allowExit = join(root, "allow-exit"), stdinClosed = join(root, "stdin-closed"), serverResponse = join(root, "server-response");
  let transport, client;
  t.after(async () => { try { await writeFile(allowExit, "exit"); await client?.close(); await transport?.close(); await within(waitUntil(() => !transport || transport.pid === undefined)); } finally { await rm(root, { recursive: true, force: true }); } });
  await writeFile(script, `import fs from 'node:fs';import readline from 'node:readline';
const [release,allowExit,stdinClosed,serverResponse]=process.argv.slice(2);let held,ended=false;
const lines=readline.createInterface({input:process.stdin});
const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
lines.on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;
if(message.method==='initialize')send({id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});
else if(message.method==='tools/call'){held=message.id;send({method:'fixture/ready'});send({id:'server-request',method:'fixture/slow'});}
else if(message.id==='server-request'&&message.method===undefined)fs.writeFileSync(serverResponse,'received');
else throw Error('Unexpected fixture request');});
lines.on('close',()=>{ended=true;fs.writeFileSync(stdinClosed,'closed');});
setInterval(()=>{if(held!==undefined&&fs.existsSync(release)){process.stderr.write('fixture stderr 日本語😀\\n');
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:held,result:{content:[{type:'text',text:'stale private result'}]}})+'\\n'+JSON.stringify({jsonrpc:'2.0',method:'fixture/stale'})+'\\n');held=undefined;}
if(ended&&fs.existsSync(allowExit))process.exit(0);},5);\n`, { mode: 0o600 });
  const options = input(); options.sessionCwd = root; options.snapshot.servers[0].config.args = [script, release, allowExit, stdinClosed, serverResponse];
  let allowed = true, stale = 0, closed = 0; options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  transport = call(create(options), options); const ready = deferred(), observedClose = deferred(), requestStarted = deferred(), finishRequest = deferred();
  transport.onError(() => { throw Error("fixture throwing error observer"); }); transport.onClose(() => { throw Error("fixture throwing close observer"); });
  const unsubscribe = transport.onMessage((message) => { if (message.method === "fixture/ready") ready.resolve(); if ((message.id !== undefined && message.result?.content) || message.method === "fixture/stale") stale++; });
  transport.onClose(() => { closed++; observedClose.resolve(); });
  client = new McpClient({ name: "fixture", version: "1", requestTimeoutMs: 60000 });
  client.setRequestHandler("fixture/slow", async (_params, { signal }) => { requestStarted.resolve(signal); await finishRequest.promise; return { done: true }; });
  await client.connect(transport); const pid = transport.pid; assert.equal(pid > 0, true);
  const rejected = assert.rejects(client.callTool("held", {}), (error) => error instanceof McpConnectionClosedError);
  await within(ready.promise); const requestSignal = await within(requestStarted.promise); allowed = false; await writeFile(release, "release");
  await within(rejected); await within(observedClose.promise); assert.equal(client.connectionState, "closed");
  assert.equal(requestSignal.aborted, true); assert.equal(stale, 0); assert.equal(closed, 1); assert.equal(transport.pid, pid);
  assert.equal(fs.existsSync(stdinClosed), false); // Native child cleanup waits for the in-flight server request.
  finishRequest.resolve();
  await within(waitUntil(() => fs.existsSync(serverResponse) && fs.existsSync(stdinClosed)));
  assert.equal(await readFile(serverResponse, "utf8"), "received"); assert.equal(await readFile(stdinClosed, "utf8"), "closed");
  unsubscribe(); await writeFile(allowExit, "exit"); await within(waitUntil(() => transport.pid === undefined));
  assert.equal(transport.stderr.includes("fixture stderr 日本語😀"), true); assert.equal(stale, 0); assert.equal(closed, 1);
  await client.close(); await transport.close(); await transport.close(); assert.equal(transport instanceof StdioTransport, true);
});

test("real SDK connected tool uses actual stdio child: explicit Japanese env, no inherited secret, fresh snapshot fences next start", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-stdio-child-")); fs.chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"), script = join(root, "peer.mjs"), configPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json");
  await mkdir(cwd);
  await writeFile(script, `import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
lines.on('line',line=>{ const message=JSON.parse(line); if(message.id===undefined)return;
switch(message.method){
case 'initialize':send(message.id,{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});break;
case 'tools/list':send(message.id,{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]});break;
case 'tools/call':send(message.id,{content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),value:process.env.VALUE,base:process.env.BASE,ambient:process.env.LEAFCODE_STDIO_PRIVATE_TEST??null})}]});break;
default:throw Error('Unexpected fixture request');}});
lines.on('close',()=>process.exit(0));\n`, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script], cwd: "work", env: { VALUE: "${EXPLICIT}", BASE: "fixed" }, exposure: "direct" } } }), { mode: 0o600 });
  await writeFile(bundledConfigPath, "{}", { mode: 0o600 }); const bytes = await readFile(configPath);
  const owner = createBackendMcpConfigOwner({ agentDir: root, bundledConfigPath, assertProcessOwner() {}, assertPrivateStorage() {} }); t.after(() => owner.dispose());
  const binding = await owner.prepare(), snapshot = binding.loadConfig();
  const factory = create({ snapshot, configPath, sessionCwd: root, homeDir: root, environment: { EXPLICIT: "日本語😀", BASE: "fixed" }, assertSnapshotOwner: binding.assertOwner });
  const transports = [], tools = new Map(), events = new Map(); let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const result = compose({ binding, mcp: { credentials: { forServer() { throw Error("No auth"); }, tokens() {}, remove() {} }, openUrl() { throw Error("No browser"); },
    createTransport: (...args) => { const transport = factory(...args); transports.push(transport); return transport; }, startupWaitMs: 0 } });
  assert.equal(result.ok, true); let active = [];
  const pi = { registerTool(tool) { tools.set(tool.name, tool); if (tool.name === "mcp__fixture__echo") resolveReady(); }, registerCommand() {}, on(name, callback) { events.set(name, callback); },
    getSettings: () => ({}), getMcpServers: () => [], getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names) => { active = names; } };
  const ctx = { cwd: root, sessionManager: { getSessionId: () => root }, mode: "print", modelRegistry: {}, ui: { notify(message) { throw Error(message); } } };
  t.after(async () => { await events.get("session_shutdown")?.({}, ctx); for (const transport of transports) await transport.close(); });
  const oldAmbient = process.env.LEAFCODE_STDIO_PRIVATE_TEST; process.env.LEAFCODE_STDIO_PRIVATE_TEST = "fixture must never inherit";
  try {
    for (const extension of result.factories) await extension(pi);
    events.get("session_start")({}, ctx);
    const timeout = setTimeout(() => resolveReady(), 5000); timeout.unref(); await ready; clearTimeout(timeout);
    assert.equal(transports.length, 1); assert.equal(transports[0].pid > 0, true); const tool = tools.get("mcp__fixture__echo"); assert.ok(tool);
    const response = await tool.execute("fixture", {}, new AbortController().signal, undefined, {});
    assert.deepEqual(JSON.parse(response.content[0].text), { cwd, value: "日本語😀", base: "fixed", ambient: null });
    const next = await owner.prepare(); next.assertOwner(); assert.throws(() => call(factory, { ...input(), sessionCwd: root }, snapshot.servers[0]), safe);
    await events.get("session_shutdown")({}, ctx); await events.get("session_shutdown")({}, ctx);
    assert.equal(transports[0].pid, undefined); next.assertOwner(); assert.deepEqual(await readFile(configPath), bytes);
  } finally { if (oldAmbient === undefined) delete process.env.LEAFCODE_STDIO_PRIVATE_TEST; else process.env.LEAFCODE_STDIO_PRIVATE_TEST = oldAmbient; }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { createBackendMcpStdioTransportFactory as create } from "./mcp-native-stdio-transport.mjs";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { prepareBackendMcpExtensionsFromBinding as compose } from "./mcp-native-extensions.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP stdio transport unavailable" && e.cause === undefined;
function input() {
  const root = join(tmpdir(), "private-stdio-fixture"), configPath = join(root, "mcp.json");
  const entry = { name: "fixture", source: configPath, scope: "global", config: { command: process.execPath,
    args: ["--version"], env: { VALUE: "prefix ${EXPLICIT}", EMPTY: "" }, exposure: "direct" } };
  return { snapshot: { servers: [entry], errors: [] }, configPath, sessionCwd: root, homeDir: root,
    environment: { EXPLICIT: "日本語", BASE: "captured" }, assertSnapshotOwner() {} };
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
  assert.deepEqual(transport.options.env, { EXPLICIT: "日本語", BASE: "captured", VALUE: "prefix 日本語", EMPTY: "" });
  assert.throws(() => { transport.options.env.VALUE = "changed"; }, TypeError);
  assert.throws(() => { transport.options.args.push("changed"); }, TypeError);
  assert.throws(() => { transport.options = {}; }, TypeError);
  await transport.close(); assert.equal(transport.pid, undefined);
  const another = call(factory, options, expected); assert.notEqual(another, transport); await another.close();
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
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script], cwd: "work", env: { VALUE: "${EXPLICIT}" }, exposure: "direct" } } }), { mode: 0o600 });
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
  const ctx = { cwd: root, mode: "print", modelRegistry: {}, ui: { notify(message) { throw Error(message); } } };
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

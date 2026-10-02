import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpClient, McpConnectionClosedError, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { createBackendMcpHttpTransportFactory as create } from "./mcp-native-http-transport.mjs";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { prepareBackendMcpExtensionsFromBinding as compose } from "./mcp-native-extensions.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP HTTP transport unavailable" && e.cause === undefined;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const notification = { jsonrpc: "2.0", method: "fixture/ping" };
function input() {
  const root = join(tmpdir(), "private-http-fixture"), configPath = join(root, "mcp.json");
  return { snapshot: { servers: [{ name: "fixture", source: configPath, scope: "global", config: {
    url: "https://fixture.invalid/mcp", headers: { "X-Fixture": "prefix ${VALUE}" }, exposure: "direct" } }], errors: [] },
    configPath, sessionCwd: root, variables: { VALUE: "fixed" }, fetch: async () => new Response(null, { status: 202 }), assertSnapshotOwner() {} };
}
const call = (factory, options, authProvider) => factory(options.snapshot.servers[0], options.sessionCwd, authProvider);

test("inert capture, fixed endpoint and headers, explicit fetch and unchanged authProvider/native receivers", async () => {
  const options = input(), requests = []; let assertions = 0, tokens = 0;
  options.assertSnapshotOwner = () => { assertions++; };
  options.fetch = async function (url, init) { assert.equal(this, undefined); requests.push({ url: String(url), init }); return new Response(null, { status: 202 }); };
  const selected = structuredClone(options.snapshot.servers[0]), factory = create(options);
  assert.equal(assertions, 0); options.variables.VALUE = "changed"; options.fetch = () => { throw Error("must not recapture"); }; options.snapshot.servers[0].config.url = "https://wrong.invalid/";
  const provider = { async token() { assert.equal(this, provider); tokens++; return "fixture-token"; } };
  const transport = factory(selected, options.sessionCwd, provider);
  assert.equal(transport instanceof StreamableHttpTransport, true); assert.equal(transport.options.authProvider, provider);
  assert.equal(tokens, 0); assert.equal(requests.length, 0); assert.equal(transport.options.headers["X-Fixture"], "prefix fixed");
  transport.url.href = "https://wrong.invalid/"; assert.equal(transport.url.href, selected.config.url);
  assert.throws(() => { transport.url = new URL("https://wrong.invalid/"); }, TypeError);
  assert.throws(() => { transport.options.headers["X-Fixture"] = "wrong"; }, TypeError);
  assert.throws(() => { transport.options = {}; }, TypeError);
  await transport.start(); await transport.send(notification); assert.equal(requests.length, 1); assert.equal(tokens, 1);
  assert.equal(requests[0].url, selected.config.url); assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.get("Authorization"), "Bearer fixture-token"); assert.equal(requests[0].init.headers.get("X-Fixture"), "prefix fixed");
  await transport.close();
});

test("strict contracts/selectors, transport/url/header/template refusals never invoke owner fetch", async () => {
  const options = input(); let fetched = 0; options.fetch = async () => { fetched++; throw Error("private unexpected network"); };
  for (const invalid of [undefined, {}, { ...options, fetch: undefined }, { ...options, variables: undefined }, { ...options, extra: true },
    { ...options, configPath: "relative" }, { ...options, assertSnapshotOwner: async () => {} }, { ...options, variables: { VALUE: "line\r\nbreak" } },
    { ...options, snapshot: { ...options.snapshot, errors: ["private invalid source"] } }]) assert.throws(() => create(invalid), safe);
  const factory = create(options), entry = options.snapshot.servers[0];
  for (const selected of [{ ...entry, name: "wrong" }, { ...entry, source: "private-other" }, { ...entry, scope: "extension" }, { ...entry, config: { url: "https://wrong.invalid/" } }]) {
    assert.throws(() => factory(selected, options.sessionCwd, undefined), safe);
  }
  assert.throws(() => factory(entry, "private-other-cwd", undefined), safe); assert.throws(() => call(factory, options, {}), safe);
  for (const config of [{ command: "never-run" }, { url: "http://remote.invalid/mcp" }, { url: "file:///private" }, { url: "https://user:private@fixture.invalid/mcp" },
    { url: "https://fixture.invalid/mcp#fragment" }, { url: "https://fixture.invalid/mcp#" }, { url: "${MISSING}" }, { url: entry.config.url, enabled: false },
    { url: entry.config.url, type: "sse" }, { url: entry.config.url, headers: { V: "${MISSING}" } }, { url: entry.config.url, headers: { V: "!never-run" } },
    { url: entry.config.url, headers: { V: "$VALUE" } }, { url: entry.config.url, headers: { V: "$$escape" } },
    { url: entry.config.url, headers: { V: "line\r\nbreak" } }, { url: entry.config.url, headers: { V: "one", v: "two" } },
    { url: entry.config.url, headers: { "bad name": "value" } }, { url: entry.config.url, unknown: true }]) {
    const changed = input(); changed.snapshot.servers[0].config = config; changed.fetch = options.fetch; assert.throws(() => call(create(changed), changed), safe);
  }
  assert.equal(fetched, 0); const healthy = call(factory, options); await healthy.close();
});

test("ambient variable names are kept but unreferencable; invalid keys/values still refuse", async () => {
  const options = input(); options.variables = { ...options.variables, "ProgramFiles(x86)": "C:\\Program Files (x86)" };
  const factory = create(options); const transport = call(factory, options); assert.equal(transport instanceof StreamableHttpTransport, true); await transport.close();
  for (const variables of [{ "": "x" }, { TOKEN: "bad\nvalue" }, { TOKEN: 1 }]) {
    assert.throws(() => create({ ...options, variables }), safe);
  }
  // A template can only name identifier variables, so an ambient-only key cannot be referenced.
  const templated = input(); templated.snapshot.servers[0].config.url = "https://example.test/${ProgramFiles(x86)}/mcp";
  templated.variables = { "ProgramFiles(x86)": "x" };
  const templatedFactory = create(templated); assert.throws(() => call(templatedFactory, templated), safe);
});

test("401 challenge receives original authProvider and explicit context fetch, then retries with its rotated token", async () => {
  const options = input(), requests = []; let token = "old", unauthorized = 0;
  options.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, auth: init.headers?.get?.("Authorization"), redirect: init.redirect });
    if (String(url) === "https://issuer.invalid/metadata") return new Response("{}", { headers: { "content-type": "application/json" } });
    if (init.headers.get("Authorization") === "Bearer old") return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
    return new Response(null, { status: 202 });
  };
  const provider = { async token() { return token; }, async onUnauthorized(context) {
    assert.equal(this, provider); unauthorized++; assert.equal(context.token, "old"); assert.equal(context.serverUrl.href, options.snapshot.servers[0].config.url);
    await context.fetch("https://issuer.invalid/metadata"); token = "new";
  } };
  const transport = call(create(options), options, provider); await transport.start(); await transport.send(notification);
  assert.equal(unauthorized, 1); assert.deepEqual(requests.map((r) => r.auth), ["Bearer old", undefined, "Bearer new"]);
  assert.equal(requests.every((r) => r.redirect === "error"), true); await transport.close();
});

test("revocation while token awaits blocks the HTTP request; async/reentrant authority cannot acknowledge a usable factory", async () => {
  const options = input(), entered = deferred(), release = deferred(); let allowed = true, fetched = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  options.fetch = async () => { fetched++; return new Response(null, { status: 202 }); };
  const provider = { async token() { entered.resolve(); await release.promise; return "fixture"; } };
  const factory = create(options), transport = call(factory, options, provider); await transport.start();
  const pending = transport.send(notification), rejected = assert.rejects(pending, safe); await entered.promise; allowed = false; release.resolve(); await rejected;
  allowed = true; await assert.rejects(transport.send(notification), safe); assert.throws(() => call(factory, options), safe); assert.equal(fetched, 0); await transport.close();
  const asyncOptions = input(); asyncOptions.assertSnapshotOwner = () => Promise.reject(Error("private async authority"));
  assert.throws(() => call(create(asyncOptions), asyncOptions), safe); await new Promise((resolve) => setImmediate(resolve));
  const reentrant = input(); let recursive, reenter = false;
  reentrant.assertSnapshotOwner = () => { if (reenter) { try { call(recursive, reentrant); } catch {} } };
  recursive = create(reentrant); reenter = true; assert.throws(() => call(recursive, reentrant), safe); reenter = false; assert.throws(() => call(recursive, reentrant), safe);
});

test("late fetch completion is rejected and body discarded; valid native fetch errors do not poison authority", async () => {
  const options = input(), entered = deferred(), release = deferred(); let allowed = true, cancelled = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  options.fetch = async () => { entered.resolve(); await release.promise; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 202 }); };
  const transport = call(create(options), options); await transport.start(); const pending = transport.send(notification), rejected = assert.rejects(pending, safe);
  await entered.promise; allowed = false; release.resolve(); await rejected; await new Promise((resolve) => setImmediate(resolve)); assert.equal(cancelled, 1); await transport.close();
  const native = input(), nativeError = Error("fixture native fetch error"); native.fetch = async () => { throw nativeError; };
  const healthyFactory = create(native), healthy = call(healthyFactory, native); await healthy.start();
  await assert.rejects(healthy.send(notification), (e) => e === nativeError); const fresh = call(healthyFactory, native); await fresh.close(); await healthy.close();
});

test("background GET stream reconnect cannot enter owner fetch after authority is lost", async () => {
  const options = input(), opened = deferred(), failed = deferred(); let allowed = true, gets = 0, controller;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  const stream = new ReadableStream({ start(value) { controller = value; } });
  options.fetch = async (_url, init) => {
    if (init.method !== "GET") return new Response(null, { status: 202 });
    gets++; opened.resolve(); return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  const transport = call(create(options), options); transport.onError((error) => failed.resolve(error)); await transport.start();
  try {
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }); await opened.promise;
    await new Promise((resolve) => setImmediate(resolve)); allowed = false; controller.close();
    const timer = setTimeout(() => failed.resolve(Error("Fixture GET retry timeout")), 4000); timer.unref(); const error = await failed.promise; clearTimeout(timer);
    assert.equal(safe(error), true); assert.equal(gets, 1); await assert.rejects(transport.send(notification), safe);
  } finally { await transport.close(); }
});

test("close after revocation still sends one fixed session DELETE, even with concurrent close and an awaiting token", async () => {
  const options = input(), requests = [], tokenEntered = deferred(), tokenRelease = deferred(); let allowed = true, closing = false;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  options.fetch = async (url, init) => { requests.push({ url: String(url), method: init.method, session: init.headers.get("Mcp-Session-Id") }); return new Response(null, { status: 202, headers: { "mcp-session-id": "fixture-session" } }); };
  const provider = { async token() { if (closing) { tokenEntered.resolve(); await tokenRelease.promise; } return "fixture"; } };
  const transport = call(create(options), options, provider); await transport.start(); await transport.send(notification);
  allowed = false; closing = true; const first = transport.close(); await tokenEntered.promise; const second = transport.close(); await second; tokenRelease.resolve(); await first;
  assert.deepEqual(requests.map((r) => r.method), ["POST", "DELETE"]); assert.equal(requests[1].session, "fixture-session"); assert.equal(requests[1].url, options.snapshot.servers[0].config.url);
  await assert.rejects(transport.options.fetch(new URL(options.snapshot.servers[0].config.url), { method: "DELETE" }), safe); assert.equal(requests.length, 2);
});

test("JSON body finishing after revocation drops every message and preserves unsubscription and idempotent close", async () => {
  const options = input(), bodyEntered = deferred(), bodyRelease = deferred(); let allowed = true, messages = 0, errors = 0, closes = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  const response = new Response("{}", { headers: { "content-type": "application/json" } });
  response.json = async () => { bodyEntered.resolve(); await bodyRelease.promise; return [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]; };
  options.fetch = async () => response;
  const transport = call(create(options), options); transport.onError((error) => { assert.equal(safe(error), true); errors++; }); transport.onClose(() => { closes++; });
  const unsubscribe = transport.onMessage(() => { messages++; }); const removed = transport.onMessage(() => { throw Error("Unsubscribed listener ran"); }); removed();
  await transport.start(); const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "fixture/request" }), rejected = assert.rejects(pending, safe);
  await bodyEntered.promise; allowed = false; bodyRelease.resolve(); await rejected;
  assert.equal(messages, 0); assert.equal(errors, 1); assert.equal(closes, 1); unsubscribe(); allowed = true;
  await assert.rejects(transport.send(notification), safe); await transport.close(); await transport.close(); assert.equal(closes, 1);
});

test("valid native message callback errors are preserved without poisoning authority or unsubscription", async () => {
  const options = input(), nativeError = Error("fixture native message observer");
  options.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } });
  const factory = create(options), transport = call(factory, options), unsubscribe = transport.onMessage(() => { throw nativeError; });
  await transport.start(); await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, method: "fixture/request" }), (error) => error === nativeError);
  unsubscribe(); const another = call(factory, options); await another.close(); await transport.close();
});

test("loss inside one message callback cannot undo that delivery but fences later listeners and later batch items", async () => {
  const options = input(); let allowed = true, first = 0, second = 0, closed = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  options.fetch = async () => new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]), { headers: { "content-type": "application/json" } });
  const transport = call(create(options), options); transport.onMessage(() => { first++; allowed = false; }); transport.onMessage(() => { second++; }); transport.onClose(() => { closed++; });
  await transport.start(); await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, method: "fixture/request" }), safe);
  assert.equal(first, 1); assert.equal(second, 0); assert.equal(closed, 1); await transport.close();
});

const within = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error("Message fixture timeout")), 4000); timer.unref(); promise.finally(() => clearTimeout(timer));
})]);

test("late POST SSE response closes real SDK client pending calls immediately despite throwing observers and held auth cleanup", async () => {
  const options = input(), streamed = deferred(), cleanupEntered = deferred(), cleanupRelease = deferred(), cleaned = deferred();
  let allowed = true, holdCleanup = false, controller, requestId, deletes = 0, delivered = 0, closed = 0;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  const stream = new ReadableStream({ start(value) { controller = value; } });
  options.fetch = async (_url, init) => {
    if (init.method === "DELETE") { deletes++; cleaned.resolve(); return new Response(null, { status: 202 }); }
    if (init.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    if (message.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }), { headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" } });
    if (message.method === "tools/call") { requestId = message.id; streamed.resolve(); return new Response(stream, { headers: { "content-type": "text/event-stream" } }); }
    return new Response(null, { status: 202 });
  };
  const provider = { async token() { if (holdCleanup) { cleanupEntered.resolve(); await cleanupRelease.promise; } return "fixture-token"; } };
  const transport = call(create(options), options, provider);
  transport.onError(() => { throw Error("fixture throwing error observer"); }); transport.onClose(() => { throw Error("fixture throwing close observer"); });
  transport.onClose(() => { closed++; }); transport.onMessage((message) => { if (message.id === requestId) delivered++; });
  const client = new McpClient({ name: "fixture", version: "1", requestTimeoutMs: 60000 });
  await client.connect(transport);
  const pending = client.callTool("echo", {}), rejected = assert.rejects(pending, (e) => e instanceof McpConnectionClosedError);
  try {
    await within(streamed.promise); await new Promise((resolve) => setImmediate(resolve)); allowed = false; holdCleanup = true;
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "stale private result" }] } })}\n\n`));
    await within(rejected); await within(cleanupEntered.promise); assert.equal(client.connectionState, "closed");
    assert.equal(delivered, 0); assert.equal(closed, 1); assert.equal(deletes, 0); // Pending released before held DELETE cleanup can finish.
    cleanupRelease.resolve(); await within(cleaned.promise); assert.equal(deletes, 1); controller.close();
  } finally { cleanupRelease.resolve(); await client.close(); await transport.close(); }
});

test("GET SSE valid notification is unchanged, stale notifications stop delivery/close once, and unsubscribes stay usable", async () => {
  const options = input(), opened = deferred(), gotMessage = deferred(), closed = deferred(); let allowed = true, messages = 0, closes = 0, controller;
  options.assertSnapshotOwner = () => { if (!allowed) throw Error("private revoked"); };
  const stream = new ReadableStream({ start(value) { controller = value; } });
  options.fetch = async (_url, init) => { if (init.method !== "GET") return new Response(null, { status: 202 }); opened.resolve(); return new Response(stream, { headers: { "content-type": "text/event-stream" } }); };
  const transport = call(create(options), options), message = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
  const unsubscribe = transport.onMessage((value) => { assert.deepEqual(value, message); messages++; gotMessage.resolve(); });
  transport.onClose(() => { closes++; closed.resolve(); }); await transport.start();
  try {
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }); await within(opened.promise);
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`)); await within(gotMessage.promise);
    allowed = false; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`)); await within(closed.promise);
    assert.equal(messages, 1); assert.equal(closes, 1); unsubscribe(); controller.close();
    await transport.close(); assert.equal(closes, 1);
  } finally { await transport.close(); }
});

test("actual redirect is refused without sending configured secret headers to its destination", async (t) => {
  let followed = 0, entered = 0;
  const target = createServer((_req, res) => { followed++; res.writeHead(202); res.end(); });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { target.closeAllConnections(); target.close(resolve); }));
  const source = createServer((_req, res) => { entered++; res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/wrong` }); res.end(); });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { source.closeAllConnections(); source.close(resolve); }));
  const options = input(); options.snapshot.servers[0].config.url = `http://127.0.0.1:${source.address().port}/mcp`;
  options.snapshot.servers[0].config.headers = { "X-Fixture": "fixture secret" }; options.fetch = globalThis.fetch;
  const transport = call(create(options), options); t.after(() => transport.close()); await transport.start();
  await assert.rejects(transport.send(notification), (e) => e instanceof TypeError); assert.equal(entered, 1); assert.equal(followed, 0); await transport.close();
});

test("real SDK and loopback HTTP preserve configured headers/provider token/protocol session and stale cleanup", async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, headers: req.headers });
    if (req.method === "GET") { res.writeHead(405); res.end(); return; }
    if (req.method === "DELETE") { res.writeHead(202); res.end(); return; }
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
    else if (message.method === "tools/call") result = { content: [{ type: "text", text: "fixture result" }], structuredContent: { value: 42 } };
    else throw Error("Unexpected fixture request");
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const root = await mkdtemp(join(tmpdir(), "leafcode-http-peer-")); fs.chmodSync(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json"), url = `http://127.0.0.1:${server.address().port}/mcp`;
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { url, headers: { "X-Fixture": "${VALUE}" }, auth: { provider: "fixture" }, exposure: "direct" } } }), { mode: 0o600 });
  await writeFile(bundledConfigPath, "{}", { mode: 0o600 }); const bytes = await readFile(configPath);
  const owner = createBackendMcpConfigOwner({ agentDir: root, bundledConfigPath, assertProcessOwner() {}, assertPrivateStorage() {} }); t.after(() => owner.dispose());
  const binding = await owner.prepare(), snapshot = binding.loadConfig(), transports = [], ready = deferred(), tools = new Map(), events = new Map();
  const factory = create({ snapshot, configPath, sessionCwd: root, variables: { VALUE: "fixed" }, fetch: globalThis.fetch, assertSnapshotOwner: binding.assertOwner });
  const result = compose({ binding, mcp: { credentials: { forServer() { throw Error("No fixture OAuth"); }, tokens() {}, remove() {} }, openUrl() { throw Error("No browser"); },
    createTransport: (...args) => { const transport = factory(...args); transports.push(transport); return transport; }, startupWaitMs: 0 } }); assert.equal(result.ok, true);
  let active = [];
  const pi = { registerTool(tool) { tools.set(tool.name, tool); if (tool.name === "mcp__fixture__echo") ready.resolve(); }, registerCommand() {}, on(name, cb) { events.set(name, cb); },
    getSettings: () => ({}), getMcpServers: () => [], getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names) => { active = names; } };
  const ctx = { cwd: root, mode: "print", modelRegistry: { async getApiKeyForProvider(provider) { assert.equal(provider, "fixture"); return "fixture-token"; } }, ui: { notify(message) { throw Error(message); } } };
  t.after(async () => { await events.get("session_shutdown")?.({}, ctx); for (const transport of transports) await transport.close(); });
  for (const extension of result.factories) await extension(pi); events.get("session_start")({}, ctx);
  const timer = setTimeout(() => ready.resolve(), 5000); timer.unref(); await ready.promise; clearTimeout(timer);
  const tool = tools.get("mcp__fixture__echo"); assert.ok(tool); const resultTool = await tool.execute("fixture", {}, new AbortController().signal, undefined, {});
  assert.equal(resultTool.content[0].text, "fixture result"); assert.equal(resultTool.structuredContent.structuredContent.value, 42);
  assert.equal(requests.every((r) => r.headers["x-fixture"] === "fixed" && r.headers.authorization === "Bearer fixture-token"), true);
  assert.equal(requests.some((r) => r.headers["mcp-session-id"] === "fixture-session" && r.headers["mcp-protocol-version"]), true);
  const fresh = await owner.prepare(), before = requests.length; await assert.rejects(transports[0].send(notification), safe); assert.equal(requests.length, before);
  await events.get("session_shutdown")({}, ctx); await events.get("session_shutdown")({}, ctx); fresh.assertOwner();
  assert.equal(requests.filter((r) => r.method === "DELETE").length, 1); assert.deepEqual(await readFile(configPath), bytes);
});

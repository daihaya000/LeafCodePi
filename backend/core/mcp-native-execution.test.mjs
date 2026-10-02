import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LATEST_PROTOCOL_VERSION, StdioTransport } from "@earendil-works/pi-mcp";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { prepareBackendMcpExtensionsFromBinding as compose } from "./mcp-native-extensions.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP extension binding unavailable" && e.cause === undefined;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// Deterministic in-process JSON-RPC peer using the public McpTransport contract. No socket,
// process, OAuth or production config. Real Pi MCP client/connection/tool definitions are used.
function transportFixture(holdInitialize = false) {
  const messages = new Set(), closes = new Set(), requests = [], held = new Map(); let closed = false, initializeId;
  const calls = { start: 0, close: 0, tools: 0, resources: 0 }, entered = deferred(), initializing = deferred();
  const initialized = () => ({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } });
  const emit = (message) => { for (const listener of messages) listener(message); };
  const respond = (id, result) => emit({ jsonrpc: "2.0", id, result });
  const listen = (set, listener) => { set.add(listener); return () => set.delete(listener); };
  const transport = {
    async start() { calls.start++; },
    async send(message) {
      requests.push(message);
      if (message.id === undefined) return;
      let result;
      switch (message.method) {
        case "initialize":
          if (holdInitialize) { initializeId = message.id; initializing.resolve(); return; }
          result = initialized(); break;
        case "tools/list": result = { tools: [{ name: "echo", description: "Fixture tool", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }; break;
        case "resources/list": result = { resources: [{ uri: "fixture://text", name: "Fixture text", mimeType: "text/plain" }] }; break;
        case "resources/templates/list": result = { resourceTemplates: [] }; break;
        case "tools/call":
          calls.tools++;
          if (message.params.arguments.hold) { held.set(message.id, message); entered.resolve(message); return; }
          result = { content: [{ type: "text", text: "fixture result" }], structuredContent: { value: 42 } }; break;
        case "resources/read": calls.resources++; result = { contents: [{ uri: "fixture://text", text: "fixture resource" }] }; break;
        default: throw Error(`Unexpected fixture request ${message.method}`);
      }
      queueMicrotask(() => respond(message.id, result));
    },
    async close() { if (!closed) { closed = true; calls.close++; for (const listener of closes) listener(); } },
    onMessage: (listener) => listen(messages, listener), onError: () => () => {}, onClose: (listener) => listen(closes, listener),
  };
  return { transport, calls, requests, entered, initializing,
    finishInitialize() { respond(initializeId, initialized()); },
    progress(message, text) { emit({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta?.progressToken, progress: 1, message: text } }); },
    finish(message) { held.delete(message.id); respond(message.id, { content: [{ type: "text", text: "late fixture result" }] }); },
  };
}
async function fixture(t, start = true, modifyTransport = (transport) => transport) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-execution-")); fs.chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { command: "never-start-fixture", exposure: "direct" } } }), { mode: 0o600 });
  await writeFile(bundledConfigPath, "{}", { mode: 0o600 });
  const owner = createBackendMcpConfigOwner({ agentDir: root, bundledConfigPath, assertProcessOwner() {}, assertPrivateStorage() {} });
  t.after(() => owner.dispose()); const binding = await owner.prepare(), peer = transportFixture(), ready = deferred(), failed = deferred();
  const tools = new Map(), commands = new Map(), events = new Map(), notices = [], registered = [], unsubscribes = [], extraPeers = [], factoryCalls = []; let active = [], registryReads = 0;
  const pi = { registerTool(definition) { tools.set(definition.name, definition); if (tools.has("mcp__fixture__echo") && tools.has("read_mcp_resource")) ready.resolve(); },
    registerCommand(name, definition) { commands.set(name, definition); }, on(name, handler) { events.set(name, handler); const unsubscribe = () => events.delete(name); unsubscribes.push(unsubscribe); return unsubscribe; },
    getSettings() { assert.equal(this, pi); return {}; }, getMcpServers: () => { registryReads++; return registered; }, getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names) => { active = names; } };
  const ctx = { cwd: root, mode: "print", modelRegistry: {}, ui: { notify: (message) => { notices.push(message); failed.resolve(message); } } };
  const result = compose({ binding, mcp: { credentials: { forServer() { throw Error("No fixture auth"); }, tokens() {}, remove() {} }, openUrl() { throw Error("No fixture browser"); }, createTransport: (...args) => { factoryCalls.push(args); if (args[0].name === "fixture") return modifyTransport(peer.transport, owner); const extra = transportFixture(true); extraPeers.push(extra); return extra.transport; }, startupWaitMs: 0 } });
  assert.equal(result.ok, true);
  for (const factory of result.factories) await factory(Object.freeze(pi)); // API view must not mutate/fail on a frozen SDK host.
  t.after(async () => { await events.get("session_shutdown")?.({}, ctx); });
  if (start) {
    assert.equal(events.get("session_start")({}, ctx), undefined); // Synchronous SDK handler stays synchronous.
    await Promise.race([ready.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Fixture connection timeout")), 5000); timer.unref(); ready.promise.finally(() => clearTimeout(timer)); })]);
  }
  return { root, configPath, owner, binding, peer, tools, commands, events, ctx, notices, registered, unsubscribes, extraPeers, factoryCalls, failed: failed.promise, connected: ready.promise, registryReads: () => registryReads };
}
const execute = (tool, params = {}, onUpdate) => tool.execute("fixture-call", params, new AbortController().signal, onUpdate, {});

test("real connected MCP tools/resources keep metadata/results, then reject before requests after binding supersession; shutdown still closes", async (t) => {
  const f = await fixture(t), tool = f.tools.get("mcp__fixture__echo"), resource = f.tools.get("read_mcp_resource"), bytes = await readFile(f.configPath);
  assert.equal(tool.exposure, "direct"); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.namespace.name, "mcp__fixture");
  const result = await execute(tool); assert.equal(result.content[0].text, "fixture result"); assert.equal(result.structuredContent.structuredContent.value, 42);
  const resourceResult = await execute(resource, { server: "fixture", uri: "fixture://text" }); assert.equal(resourceResult.content[0].text, "fixture resource");
  assert.deepEqual(f.peer.calls, { start: 1, close: 0, tools: 1, resources: 1 });
  const fresh = await f.owner.prepare(); fresh.assertOwner();
  for (const [name, params] of [["mcp__fixture__echo", {}], ["read_mcp_resource", { server: "fixture", uri: "fixture://text" }], ["codemode", { code: "return 42" }], ["tool_search", { query: "echo" }]]) await assert.rejects(execute(f.tools.get(name), params), safe);
  await assert.rejects(f.commands.get("mcp").handler("reconnect fixture", f.ctx), safe);
  assert.deepEqual(f.peer.calls, { start: 1, close: 0, tools: 1, resources: 1 });
  await f.events.get("session_shutdown")({}, f.ctx); await f.events.get("session_shutdown")({}, f.ctx);
  assert.equal(f.peer.calls.close, 1); fresh.assertOwner(); assert.deepEqual(await readFile(f.configPath), bytes); assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("in-flight MCP progress/completion becomes unavailable after cooperative ABA, without pretending the server call was cancelled", async (t) => {
  const f = await fixture(t), updates = [], tool = f.tools.get("mcp__fixture__echo"), bytes = await readFile(f.configPath);
  const pending = execute(tool, { hold: true }, (value) => updates.push(value)); const rejected = assert.rejects(pending, safe);
  const message = await f.peer.entered.promise; f.peer.progress(message, "initial progress"); assert.equal(updates.length, 1);
  await f.owner.runWrite((scope) => { scope.assertOwner(); fs.writeFileSync(f.configPath, "{}"); fs.writeFileSync(f.configPath, bytes); });
  // The protocol client catches progress-listener errors; the guard must stay terminal even then.
  f.peer.progress(message, "stale progress"); assert.equal(updates.length, 1);
  f.peer.finish(message); await rejected; assert.equal(f.peer.calls.tools, 1);
  await assert.rejects(execute(tool), safe); assert.equal(f.peer.calls.tools, 1);
  await f.events.get("session_shutdown")({}, f.ctx); assert.equal(f.peer.calls.close, 1);
  (await f.owner.prepare()).assertOwner(); assert.deepEqual(await readFile(f.configPath), bytes);
});

test("completion-only fencing rejects a late tool result even without progress, and old executors never poison a fresh owner generation", async (t) => {
  const f = await fixture(t), tool = f.tools.get("mcp__fixture__echo");
  const pending = execute(tool, { hold: true }); const rejected = assert.rejects(pending, safe);
  const message = await f.peer.entered.promise, fresh = await f.owner.prepare(); fresh.assertOwner();
  f.peer.finish(message); await rejected; assert.equal(f.peer.calls.tools, 1);
  await assert.rejects(execute(tool), safe); fresh.assertOwner();
  await f.events.get("session_shutdown")({}, f.ctx); assert.equal(f.peer.calls.close, 1); fresh.assertOwner();
});

test("observed source failure permanently closes existing executors despite restoration, while dispose never blocks shutdown", async (t) => {
  const f = await fixture(t), tool = f.tools.get("mcp__fixture__echo"), bytes = await readFile(f.configPath);
  await writeFile(f.configPath, Buffer.concat([bytes, Buffer.from("\n")])); await assert.rejects(execute(tool), safe);
  await writeFile(f.configPath, bytes); await assert.rejects(execute(tool), safe); assert.equal(f.peer.calls.tools, 0);
  f.owner.dispose(); await f.events.get("session_shutdown")({}, f.ctx); assert.equal(f.peer.calls.close, 1);
});

test("valid native tool errors do not poison binding, and command completion cannot claim success after callback-triggered revocation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(execute(f.tools.get("tool_search"), { query: "" }), /query must not be empty/); f.binding.assertOwner();
  await execute(f.tools.get("mcp__fixture__echo"));
  const entered = deferred(), release = deferred();
  const command = f.commands.get("mcp"), ctx = { ...f.ctx, ui: { notify() { entered.resolve(); } } };
  // /mcp reconnect awaits connection work. Invalidate during that await using transport.close.
  const close = f.peer.transport.close;
  f.peer.transport.close = async () => { entered.resolve(); await release.promise; await close(); };
  const pending = command.handler("reconnect fixture", ctx); const rejected = assert.rejects(pending, safe);
  await entered.promise; f.owner.dispose(); release.resolve(); await rejected;
  assert.equal(f.peer.calls.close, 1);
});

test("stale lifecycle entry never reads registrations or starts transports, and shutdown/unsubscribe stay usable", async (t) => {
  const f = await fixture(t, false), fresh = await f.owner.prepare(); fresh.assertOwner();
  f.registered.push({ name: "extra", config: { command: "never-start-extra" }, extensionPath: "fixture-extension" });
  assert.throws(() => f.events.get("session_start")({}, f.ctx), safe);
  await assert.rejects(f.events.get("mcp_servers_change")({}, f.ctx), safe);
  await assert.rejects(f.events.get("turn_start")({}, f.ctx), safe);
  assert.equal(f.registryReads(), 0); assert.equal(f.peer.calls.start, 0); assert.equal(f.extraPeers.length, 0);
  await f.events.get("session_shutdown")({}, f.ctx); fresh.assertOwner();
  for (const unsubscribe of f.unsubscribes) unsubscribe(); assert.equal(f.events.size, 0); fresh.assertOwner();
});

test("async turn_start cannot return a successful completion after owner supersession, even when native handler had nothing to reconnect", async (t) => {
  const f = await fixture(t, false), pending = f.events.get("turn_start")({}, f.ctx), rejected = assert.rejects(pending, safe);
  const fresh = await f.owner.prepare(); await rejected; fresh.assertOwner();
  assert.equal(f.peer.calls.start, 0); await f.events.get("session_shutdown")({}, f.ctx); fresh.assertOwner();
});

test("mcp_servers_change late completion rejects after supersession, then cleanup closes both started fixture connections", async (t) => {
  const f = await fixture(t);
  f.registered.push({ name: "extra", config: { command: "never-start-extra", exposure: "direct" }, extensionPath: "fixture-extension" });
  const pending = f.events.get("mcp_servers_change")({}, f.ctx), rejected = assert.rejects(pending, safe);
  assert.equal(f.extraPeers.length, 0); // Handler has yielded to the SDK's connection preparation.
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.extraPeers.length, 1);
  const extra = f.extraPeers[0]; await extra.initializing.promise;
  const fresh = await f.owner.prepare(); extra.finishInitialize(); await rejected; fresh.assertOwner();
  assert.equal(extra.calls.start, 1); assert.equal(f.peer.calls.start, 1);
  await assert.rejects(execute(f.tools.get("mcp__extra__echo")), safe); assert.equal(extra.calls.tools, 0);
  await assert.rejects(f.events.get("mcp_servers_change")({}, f.ctx), safe);
  await f.events.get("session_shutdown")({}, f.ctx); await f.events.get("session_shutdown")({}, f.ctx);
  assert.equal(extra.calls.close, 1); assert.equal(f.peer.calls.close, 1); fresh.assertOwner();
});

const within = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error("Transport fixture timeout")), 5000); timer.unref(); promise.finally(() => clearTimeout(timer));
})]);

test("synchronous session_start background work cannot enter the owner transport factory after supersession", async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.events.get("session_start")({}, f.ctx), undefined);
  const preparing = f.owner.prepare(); // Retires binding before SDK setImmediate/runtime load.
  const message = await within(f.failed), fresh = await preparing; fresh.assertOwner();
  assert.match(message, /MCP extension binding unavailable/);
  assert.equal(f.factoryCalls.length, 0); assert.equal(f.peer.calls.start, 0); assert.equal(f.peer.requests.length, 0);
  assert.equal(f.tools.has("mcp__fixture__echo"), false);
  await f.events.get("session_shutdown")({}, f.ctx); assert.equal(f.peer.calls.close, 0); fresh.assertOwner();
});

test("owner revocation inside creation closes the unreturned transport without ever starting it", async (t) => {
  const f = await fixture(t, false, (transport, owner) => { owner.dispose(); return transport; });
  f.events.get("session_start")({}, f.ctx); assert.match(await within(f.failed), /MCP extension binding unavailable/);
  assert.equal(f.factoryCalls.length, 1); assert.equal(f.peer.calls.start, 0); assert.equal(f.peer.calls.close, 1); assert.equal(f.peer.requests.length, 0);
  await f.events.get("session_shutdown")({}, f.ctx); assert.equal(f.peer.calls.close, 1);
});

test("listener setup may revoke after creation; start refuses entry and SDK cleanup still closes/unsubscribes", async (t) => {
  let unsubscribed = 0;
  const f = await fixture(t, false, (transport, owner) => ({ ...transport, onMessage(listener) {
    const unsubscribe = transport.onMessage(listener); owner.dispose(); return () => { unsubscribed++; unsubscribe(); };
  } }));
  f.events.get("session_start")({}, f.ctx); assert.match(await within(f.failed), /MCP extension binding unavailable/);
  assert.equal(f.factoryCalls.length, 1); assert.equal(f.peer.calls.start, 0); assert.equal(f.peer.calls.close, 1); assert.equal(unsubscribed, 1);
  assert.equal(f.peer.requests.length, 0); await f.events.get("session_shutdown")({}, f.ctx); assert.equal(f.peer.calls.close, 1);
});

test("late start completion after supersession closes started work before initialize; it does not cancel that work", async (t) => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, false, (transport) => ({ ...transport, async start() { await transport.start(); entered.resolve(); await release.promise; } }));
  f.events.get("session_start")({}, f.ctx); await within(entered.promise);
  const fresh = await f.owner.prepare(); release.resolve(); assert.match(await within(f.failed), /MCP extension binding unavailable/); fresh.assertOwner();
  assert.equal(f.peer.calls.start, 1); assert.equal(f.peer.calls.close, 1); assert.equal(f.peer.requests.length, 0);
  await f.events.get("session_shutdown")({}, f.ctx); fresh.assertOwner();
});

test("frozen StdioTransport identity/private receiver/native errors survive the start guard", async (t) => {
  let stderrReads = 0;
  class PrivateTransport extends StdioTransport {
    #peer;
    constructor(peer) { super({ command: "never-start-fixture" }); this.#peer = peer; Object.freeze(this); }
    get stderr() { stderrReads++; return "fixture stderr"; }
    async start() { await this.#peer.start(); throw Error("fixture native start error"); }
    send(message) { return this.#peer.send(message); }
    close() { return this.#peer.close(); }
    onMessage(listener) { return this.#peer.onMessage(listener); }
    onError(listener) { return this.#peer.onError(listener); }
    onClose(listener) { return this.#peer.onClose(listener); }
  }
  const f = await fixture(t, false, (transport) => new PrivateTransport(transport));
  f.events.get("session_start")({}, f.ctx); const message = await within(f.failed);
  assert.match(message, /fixture native start error/); assert.equal(stderrReads > 0, true); // Startup report is first-line only; SDK reads stderr only after instanceof StdioTransport.
  f.binding.assertOwner();
  assert.equal(f.factoryCalls[0][0].name, "fixture"); assert.equal(f.factoryCalls[0][1], f.root); assert.equal(f.factoryCalls[0][2], undefined);
  assert.equal(f.peer.calls.start, 1); assert.equal(f.peer.calls.close, 1); assert.equal(f.peer.requests.length, 0);
  await f.events.get("turn_start")({}, f.ctx); await f.events.get("session_shutdown")({}, f.ctx); f.binding.assertOwner();
});

test("invalid owner transport results fail closed; rejected best-effort close never replaces stale errors", async (t) => {
  for (const result of [undefined, null, {}, { start() {} }]) {
    const f = await fixture(t, false, () => result);
    f.events.get("session_start")({}, f.ctx); assert.match(await within(f.failed), /MCP extension binding unavailable/);
    assert.equal(f.peer.calls.start, 0); assert.equal(f.peer.requests.length, 0); f.binding.assertOwner();
  }
  const f = await fixture(t, false, (transport, owner) => {
    owner.dispose(); return { ...transport, async close() { await transport.close(); throw Error("fixture cleanup failure"); } };
  });
  f.events.get("session_start")({}, f.ctx); assert.match(await within(f.failed), /MCP extension binding unavailable/);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.peer.calls.start, 0); assert.equal(f.peer.calls.close, 1);
});

test("a lying synchronous factory cannot return a rejected Promise as a native transport", async (t) => {
  const f = await fixture(t, false, () => Promise.reject(Error("fixture invalid async factory")));
  f.events.get("session_start")({}, f.ctx); assert.match(await within(f.failed), /MCP extension binding unavailable/);
  await new Promise((resolve) => setImmediate(resolve)); f.binding.assertOwner();
  assert.equal(f.factoryCalls.length, 1); assert.equal(f.peer.calls.start, 0); assert.equal(f.peer.requests.length, 0);
});

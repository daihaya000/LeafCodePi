import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { browserOpenCommand, createBrowserOpener, createNativeMcpActivation, createNativeMcpStartup, isNativeMcpRequested } from "./mcp-native-activation.mjs";

const safe = (e) => e instanceof Error && e.message === "MCP native activation unavailable" && e.cause === undefined;

/** Fake bundle module: records what activation passes and how the provider is installed. */
function fakeRuntime({ createThrows = false, prepareThrows = false, forSession } = {}) {
  const calls = { options: [], prepare: 0, providers: [], dispose: 0 };
  const prepared = { binding: Object.freeze({}), forSession: forSession ?? (() => "session") };
  return { calls, prepared,
    createBackendMcpNativeRuntime(options) {
      calls.options.push(options);
      if (createThrows) throw Error("private create failure");
      return { async prepare() { calls.prepare++; if (prepareThrows) throw Error("private prepare failure"); return prepared; }, dispose() { calls.dispose++; } };
    },
    setBackendMcpNativeSessionProvider(next) { calls.providers.push(next); },
  };
}

test("the opt-in flag is off by default and only explicit native values enable it", () => {
  for (const env of [{}, { LEAFCODE_PI_MCP_NATIVE: "" }, { LEAFCODE_PI_MCP_NATIVE: "0" }, { LEAFCODE_PI_MCP_NATIVE: "off" }, { LEAFCODE_PI_MCP_NATIVE: "adapter" }]) {
    assert.equal(isNativeMcpRequested(env), false, JSON.stringify(env));
  }
  for (const value of ["1", "true", "TRUE", " yes ", "on", "native"]) {
    assert.equal(isNativeMcpRequested({ LEAFCODE_PI_MCP_NATIVE: value }), true, value);
  }
});

test("construction is inert and refuses unknown keys, empty paths and async/foreign services", () => {
  const root = { agentDir: "C:/private-agent", environment: {}, variables: {}, fetch: async () => {}, openUrl: async () => {}, assertProcessOwner() {} };
  const activation = createNativeMcpActivation(root);
  assert.equal(activation.status(), "idle");
  for (const change of [() => null, () => [], () => ({ ...root, extra: true }), () => ({ ...root, agentDir: "" }),
    () => ({ ...root, homeDir: "" }), () => ({ ...root, fetch: "global" }), () => ({ ...root, openUrl: 7 }),
    () => ({ ...root, assertProcessOwner: async () => {} }), () => ({ ...root, environment: [] })]) {
    assert.throws(() => createNativeMcpActivation(change()), safe);
  }
  activation.dispose(); assert.equal(activation.status(), "disposed");
});

test("initialize snapshots explicit options and installs the prepared provider without ambient defaults", async () => {
  const environment = { TOKEN: "one", NUMBER: 7 }; const variables = { URL: "https://example.test/mcp", FLAG: true };
  const fetch = async () => new Response(""); const openUrl = async () => {};
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", homeDir: "C:/private-home", environment, variables, fetch, openUrl });
  environment.TOKEN = "changed"; variables.URL = "changed"; // snapshotted at construction
  const runtime = fakeRuntime();
  assert.equal(await activation.initialize(runtime), undefined);
  assert.equal(activation.status(), "active"); assert.equal(runtime.calls.prepare, 1);
  assert.deepEqual(runtime.calls.providers, [runtime.prepared.forSession]);
  const options = runtime.calls.options[0];
  assert.equal(options.agentDir, "C:/private-agent"); assert.equal(options.homeDir, "C:/private-home");
  assert.deepEqual(options.environment, { TOKEN: "one" }); assert.deepEqual(options.variables, { URL: "https://example.test/mcp" });
  assert.equal(options.fetch, fetch); assert.equal(options.openUrl, openUrl); assert.equal(typeof options.assertProcessOwner, "function");
  assert.equal(Object.getPrototypeOf(options.environment), Object.prototype);
  // No default storage checks/browser/fetch are smuggled in: the runtime owns its own defaults.
  assert.deepEqual(Object.keys(options).sort(), ["agentDir", "assertProcessOwner", "bundledConfigPath", "environment", "fetch", "homeDir", "openUrl", "variables"]);
  await assert.rejects(activation.initialize(fakeRuntime()), safe); // at most one successful attempt
  activation.dispose();
});

test("default services are present: a browser opener, global fetch and a synchronous no-op owner assertion", async () => {
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  const runtime = fakeRuntime(); await activation.initialize(runtime);
  const options = runtime.calls.options[0];
  assert.equal(typeof options.fetch, "function"); assert.equal(typeof options.openUrl, "function");
  assert.equal(options.assertProcessOwner(), undefined); assert.equal(options.bundledConfigPath instanceof URL, true);
  activation.dispose();
});

test("a failed creation/preparation is sanitized, disposes the owner and never installs a provider", async () => {
  for (const [runtime, expectedDisposals] of [[fakeRuntime({ createThrows: true }), 0], [fakeRuntime({ prepareThrows: true }), 1]]) {
    const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
    await assert.rejects(activation.initialize(runtime), safe);
    assert.equal(activation.status(), "failed"); assert.deepEqual(runtime.calls.providers, []);
    // A created owner is released; a creation that never returned one has nothing to release.
    assert.equal(runtime.calls.dispose, expectedDisposals);
    await assert.rejects(activation.initialize(fakeRuntime()), safe);
    activation.dispose();
  }
});

test("the entry composition requires both the attached runtime and the explicit opt-in flag", async () => {
  const on = { LEAFCODE_PI_MCP_NATIVE: "1" }, off = {};
  assert.equal(createNativeMcpStartup({ runtimeRequested: false, env: on }), null, "a detached Backend never activates native MCP");
  assert.equal(createNativeMcpStartup({ runtimeRequested: true, env: off }), null, "unset flag keeps the adapter");
  assert.equal(createNativeMcpStartup({ runtimeRequested: undefined, env: on }), null);
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  const initialize = createNativeMcpStartup({ runtimeRequested: true, env: on, activation });
  assert.equal(typeof initialize, "function");
  const runtime = fakeRuntime(); assert.equal(await initialize(runtime), undefined);
  assert.deepEqual(runtime.calls.providers, [runtime.prepared.forSession]); assert.equal(activation.status(), "active");
  activation.dispose();
});

test("a malformed bundle module and a non-http auth URL fail closed", async () => {
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  for (const module of [undefined, {}, { createBackendMcpNativeRuntime() {} }, { setBackendMcpNativeSessionProvider() {} }]) {
    await assert.rejects(activation.initialize(module), safe);
  }
  assert.equal(activation.status(), "idle"); // an invalid module is not an attempt
  const opener = createBrowserOpener();
  for (const url of ["javascript:alert(1)", "file:///C:/private", "not a url", "", undefined]) {
    await assert.rejects(opener(url), safe);
  }
});

test("the browser opener uses a shell-free launcher and reports only sanitized failures", async () => {
  assert.deepEqual(browserOpenCommand("win32", "https://example.test/x"), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://example.test/x"] });
  assert.deepEqual(browserOpenCommand("darwin", "https://example.test/x"), { command: "open", args: ["https://example.test/x"] });
  assert.deepEqual(browserOpenCommand("linux", "https://example.test/x"), { command: "xdg-open", args: ["https://example.test/x"] });
  const launched = [];
  const spawnStub = () => { const child = new EventEmitter(); child.unref = () => { child.unrefCalled = true; }; launched.push(child); setImmediate(() => child.emit("spawn")); return child; };
  const opener = createBrowserOpener({ platform: "linux", launch: (command, args) => (launched.push({ command, args }), spawnStub()) });
  assert.equal(await opener("https://example.test/auth?state=secret"), undefined);
  assert.deepEqual(launched[0], { command: "xdg-open", args: ["https://example.test/auth?state=secret"] });
  assert.equal(launched[1].unrefCalled, true);
  // A launcher that cannot start, and one that throws, are both reported without OS text.
  const failing = createBrowserOpener({ platform: "linux", launch: () => { const child = new EventEmitter(); child.unref = () => {}; setImmediate(() => child.emit("error", Error("private spawn failure"))); return child; } });
  await assert.rejects(failing("https://example.test/x"), safe);
  const throwing = createBrowserOpener({ platform: "linux", launch: () => { throw Error("private launch failure"); } });
  await assert.rejects(throwing("https://example.test/x"), safe);
});

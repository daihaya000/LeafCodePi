import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { browserOpenCommand, createBrowserOpener, createNativeMcpActivation, createNativeMcpStartup, isNativeMcpRequested, legacyAuthWriteRefusal } from "./mcp-native-activation.mjs";

const safe = (e) => e instanceof Error && e.message === "MCP native activation unavailable" && e.cause === undefined;

/** Fake bundle module: records what activation passes and how the provider is installed. */
function fakeRuntime({ createThrows = false, installThrows = false, republishThrows = false, forSession } = {}) {
  const calls = { options: [], installs: 0, dispose: 0, scopes: [], statusReads: [] };
  const prepared = { binding: Object.freeze({}), forSession: forSession ?? (() => "session"),
    readOAuthStatus(name) { calls.statusReads.push(name); return { name, configPath: "", authType: "oauth", credentialSource: "oauth", credentialConfigured: true, credentialStatus: "present" }; } };
  return { calls, prepared,
    createBackendMcpNativeRuntime(options) {
      calls.options.push(options);
      if (createThrows) throw Error("private create failure");
      return {
        async install() {
          calls.installs++;
          if (installThrows) throw Error("private install failure");
          if (republishThrows && calls.installs > 1) throw Error("private republish failure");
          return prepared;
        },
        runWrite(work) { return Promise.resolve().then(() => work({ fixture: true })); },
        dispose() { calls.dispose++; },
      };
    },
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
  assert.equal(activation.status(), "active"); assert.equal(runtime.calls.installs, 1);
  const options = runtime.calls.options[0];
  assert.equal(options.agentDir, "C:/private-agent"); assert.equal(options.homeDir, "C:/private-home");
  assert.deepEqual(options.environment, { TOKEN: "one" }); assert.deepEqual(options.variables, { URL: "https://example.test/mcp" });
  assert.equal(options.fetch, fetch); assert.equal(options.openUrl, openUrl); assert.equal(typeof options.assertProcessOwner, "function");
  assert.equal(Object.getPrototypeOf(options.environment), Object.prototype);
  // No default storage checks/browser/fetch are smuggled in: the runtime owns its own defaults.
  assert.deepEqual(Object.keys(options).sort(), ["agentDir", "assertProcessOwner", "bundledConfigPath", "envCommands", "environment", "fetch", "homeDir", "openUrl", "variables"]);
  assert.equal(typeof options.envCommands.run, "function");
  // The runtime takes an absolute path string; a URL here made every activation refuse.
  assert.equal(typeof options.bundledConfigPath, "string");
  assert.equal(options.bundledConfigPath.endsWith(`${sep}extensions${sep}leafcode-mcp-adapter${sep}mcp.json`), true);
  await assert.rejects(activation.initialize(fakeRuntime()), safe); // at most one successful attempt
  activation.dispose();
});

test("an injected env-command resolver is used instead of the shell default", async () => {
  const commands = [];
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {},
    runEnvCommand: (command) => { commands.push(command); return "resolved"; } });
  const runtime = fakeRuntime(); await activation.initialize(runtime);
  assert.equal(runtime.calls.options[0].envCommands.run("print-key"), "resolved");
  assert.deepEqual(commands, ["print-key"]);
  assert.throws(() => createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {}, runEnvCommand: async () => "x" }), safe);
  activation.dispose();
});

test("default services are present: a browser opener, global fetch and a synchronous no-op owner assertion", async () => {
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  const runtime = fakeRuntime(); await activation.initialize(runtime);
  const options = runtime.calls.options[0];
  assert.equal(typeof options.fetch, "function"); assert.equal(typeof options.openUrl, "function");
  assert.equal(options.assertProcessOwner(), undefined); assert.equal(typeof options.bundledConfigPath, "string");
  activation.dispose();
});

test("a failed creation/preparation is sanitized, disposes the owner and never installs a provider", async () => {
  for (const [runtime, expectedInstalls, expectedDisposals] of [[fakeRuntime({ createThrows: true }), 0, 0], [fakeRuntime({ installThrows: true }), 1, 1]]) {
    const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
    await assert.rejects(activation.initialize(runtime), safe);
    assert.equal(activation.status(), "failed"); assert.equal(runtime.calls.installs, expectedInstalls);
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
  assert.equal(typeof initialize.initializeRuntime, "function"); assert.equal(typeof initialize.runConfigWrite, "function");
  const runtime = fakeRuntime(); assert.equal(await initialize.initializeRuntime(runtime), undefined);
  assert.equal(runtime.calls.installs, 1); assert.equal(activation.status(), "active");
  assert.equal(await initialize.runConfigWrite(() => "written"), "written");
  assert.equal(runtime.calls.installs, 2);
  activation.dispose();
});

test("config writes run in the owner writer scope and republish; failures never claim success", async () => {
  const runtime = fakeRuntime();
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  await assert.rejects(activation.runConfigWrite(() => "too early"), safe); // never active
  await activation.initialize(runtime);
  const scopes = [];
  assert.equal(await activation.runConfigWrite((scope) => { scopes.push(scope); return "written"; }), "written");
  assert.deepEqual(scopes, [{ fixture: true }]); assert.equal(runtime.calls.installs, 2);
  // A failing write keeps its own error and is not republished.
  await assert.rejects(activation.runConfigWrite(() => { throw Error("private write failure"); }), /private write failure/);
  assert.equal(runtime.calls.installs, 2);
  await assert.rejects(activation.runConfigWrite("not a function"), safe);
  // A failing republish is sanitized and already retired the binding: no silent stale snapshot.
  const republish = fakeRuntime({ republishThrows: true });
  const second = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  await second.initialize(republish);
  await assert.rejects(second.runConfigWrite(() => "written"), safe);
  await assert.rejects(second.runConfigWrite(() => "written"), safe);
  assert.equal(republish.calls.installs, 3);
  second.dispose(); await assert.rejects(second.runConfigWrite(() => "written"), safe);
  activation.dispose();
});

test("the Backend entry routes both MCP config writes through the native hooks", async () => {
  // The entry runs the server at import time, so this is a source regression guard: dropping either
  // hook would silently leave a stale or retired provider after an ON/OFF or preset write.
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "entry.mjs"), "utf8");
  assert.ok(source.includes("createNativeMcpStartup({ runtimeRequested })"));
  assert.ok(source.includes("initializeRuntime: nativeMcp.initializeRuntime"));
  assert.ok(source.includes("nativeMcp.runConfigWrite(write)"));
  assert.ok(source.includes("nativeMcp.runConfigWrite(() => runtime.createMcpPreset(input))"));
  assert.ok(source.includes("return nativeMcp.readAuthStatus(name)") || source.includes("return nativeMcp.readAuthStatus(name);"));
  assert.ok(source.includes("if (nativeMcp) throw legacyAuthWriteRefusal();"));
});

test("native auth status reads come from the installed snapshot; a retired or unsupported read refuses", async () => {
  const runtime = fakeRuntime();
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  assert.throws(() => activation.readAuthStatus("remote"), safe); // before install
  await activation.initialize(runtime);
  const status = activation.readAuthStatus("remote");
  assert.equal(status.credentialStatus, "present"); assert.deepEqual(runtime.calls.statusReads, ["remote"]);
  // The republish keeps the newest snapshot: a config write reads through the same prepared handle.
  const republished = fakeRuntime(); const second = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  await second.initialize(republished);
  await second.runConfigWrite(() => "written");
  assert.equal(second.readAuthStatus("remote").credentialStatus, "present");
  assert.deepEqual(republished.calls.statusReads, ["remote"]);
  second.dispose(); assert.throws(() => second.readAuthStatus("remote"), safe);
  // A prepared handle without the read entry (older runtime) refuses instead of guessing.
  const legacy = { calls: {}, createBackendMcpNativeRuntime: () => ({ async install() { return { binding: {}, forSession: () => "session" }; }, runWrite: (work) => work({}), dispose() {} }) };
  const third = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  await third.initialize(legacy); assert.throws(() => third.readAuthStatus("remote"), safe);
  activation.dispose(); third.dispose();
});

test("legacy adapter auth writes are refused with a 409 while native MCP is active", () => {
  const refusal = legacyAuthWriteRefusal();
  assert.equal(refusal.status, 409); assert.equal(refusal.cause, undefined);
  assert.equal(/private|token|store/i.test(refusal.message), false);
});

test("a malformed bundle module and a non-http auth URL fail closed", async () => {
  const activation = createNativeMcpActivation({ agentDir: "C:/private-agent", environment: {}, variables: {} });
  for (const module of [undefined, {}, "not-a-module"]) await assert.rejects(activation.initialize(module), safe);
  assert.equal(activation.status(), "idle"); // a module that cannot create an owner is not an attempt
  for (const module of [{ createBackendMcpNativeRuntime() {} }, { createBackendMcpNativeRuntime: () => ({}) },
    { createBackendMcpNativeRuntime: () => ({ install: "no-ack" }) }]) await assert.rejects(activation.initialize(module), safe);
  assert.equal(activation.status(), "failed"); // an owner without the install path is fenced, not half-installed
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

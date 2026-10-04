import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { bundledPathsForNativeMcp, nativeMcpExtensionFactory, resolveBackendMcpNativeSession, setBackendMcpNativeSessionProvider } from "./mcp-native-session.mjs";

afterEach(() => setBackendMcpNativeSessionProvider(undefined));

test("default is inactive: legacy adapter stays loaded and no factory is produced", () => {
  assert.deepEqual(resolveBackendMcpNativeSession("C:/work"), { active: false, factories: [], issues: [] });
  const entries = [{ name: "leafcode-mcp-adapter" }, { name: "other" }];
  assert.deepEqual(bundledPathsForNativeMcp(entries, false), entries);
});

test("active provider yields detached native factories and drops only the bundled adapter", () => {
  const factory = () => {}; const cwds = [];
  setBackendMcpNativeSessionProvider((cwd) => { cwds.push(cwd); return { ok: true, issues: [], sourceSha256: null, bundledSha256: "x", serverCount: 0, factories: [factory, factory, factory] }; });
  const first = resolveBackendMcpNativeSession("C:/work"); first.factories.pop();
  assert.equal(first.active, true); assert.equal(resolveBackendMcpNativeSession("C:/other").factories.length, 3); assert.deepEqual(cwds, ["C:/work", "C:/other"]);
  assert.deepEqual(bundledPathsForNativeMcp([{ name: "leafcode-mcp-adapter" }, { name: "leafcode-todowrite" }], true), [{ name: "leafcode-todowrite" }]);
});

test("failed or throwing preparation never falls back to the adapter and leaks no private detail", () => {
  setBackendMcpNativeSessionProvider(() => ({ ok: false, issues: [{ code: "invalid-loader-options", field: "private" }], factories: null }));
  assert.deepEqual(resolveBackendMcpNativeSession("C:/work"), { active: true, factories: [], issues: [{ code: "invalid-loader-options" }] });
  setBackendMcpNativeSessionProvider(() => { throw Error("private cause"); });
  assert.deepEqual(resolveBackendMcpNativeSession("C:/work"), { active: true, factories: [], issues: [{ code: "native-session-provider-failed" }] });
  setBackendMcpNativeSessionProvider(() => undefined);
  assert.deepEqual(resolveBackendMcpNativeSession("C:/work").issues, [{ code: "native-session-unavailable" }]);
});

test("nativeMcpExtensionFactory resolves the provider on every run so a reload picks up the newest binding", () => {
  const called = [];
  const factoryA = () => called.push("A"), factoryB = () => called.push("B");
  const loader = nativeMcpExtensionFactory("C:/work");
  assert.equal(loader({ id: 1 }), undefined); assert.deepEqual(called, [], "no provider means no factories");
  setBackendMcpNativeSessionProvider(() => ({ ok: true, factories: [factoryA] }));
  loader({ id: 1 }); assert.deepEqual(called, ["A"]);
  // A config write republishes the provider: the same loader must not replay the retired binding.
  setBackendMcpNativeSessionProvider(() => ({ ok: true, factories: [factoryB] }));
  loader({ id: 2 }); assert.deepEqual(called, ["A", "B"]);
  setBackendMcpNativeSessionProvider(() => ({ ok: false, issues: [{ code: "x" }], factories: null }));
  loader({ id: 3 }); assert.deepEqual(called, ["A", "B"], "a failed preparation yields no factories");
});

test("standalone codemode is retained whenever native factories are unavailable, also across reloads", async () => {
  const calls = [];
  const standalone = async () => { calls.push("standalone"); };
  const native = () => { calls.push("native"); };
  const loader = nativeMcpExtensionFactory("C:/work", standalone);
  await loader({});
  assert.deepEqual(calls, ["standalone"]);
  setBackendMcpNativeSessionProvider(() => ({ ok: true, factories: [native] }));
  await loader({});
  assert.deepEqual(calls, ["standalone", "native"], "native supplies codemode without a duplicate");
  setBackendMcpNativeSessionProvider(() => ({ ok: false, issues: [{ code: "x" }], factories: null }));
  await loader({});
  assert.deepEqual(calls, ["standalone", "native", "standalone"], "failed native preparation retains codemode, not MCP");
  setBackendMcpNativeSessionProvider(undefined);
  await loader({});
  assert.deepEqual(calls, ["standalone", "native", "standalone", "standalone"]);
  await assert.rejects(Promise.resolve(nativeMcpExtensionFactory("C:/work", async () => { throw Error("standalone failed"); })({})), /standalone failed/);
});

test("active providers without usable factories retain standalone codemode while MCP stays fail-closed", async () => {
  let standaloneCalls = 0, nativeCalls = 0;
  const native = () => { nativeCalls++; };
  const loader = nativeMcpExtensionFactory("C:/work", async () => { standaloneCalls++; });
  const entries = [{ name: "leafcode-mcp-adapter" }, { name: "other" }];
  const cases = [
    ["empty success", () => ({ ok: true, factories: [] })],
    ["failed preparation", () => ({ ok: false, factories: null })],
    ["stale factories on failure", () => ({ ok: false, factories: [native] })],
    ["throwing provider", () => { throw Error("private cause"); }],
    ["unavailable binding", () => undefined],
  ];
  for (const [label, provider] of cases) {
    setBackendMcpNativeSessionProvider(provider);
    const resolved = resolveBackendMcpNativeSession("C:/work");
    assert.equal(resolved.active, true, label);
    assert.deepEqual(resolved.factories, [], label);
    assert.deepEqual(bundledPathsForNativeMcp(entries, resolved.active), [{ name: "other" }], label);
    const before = standaloneCalls;
    await loader({});
    assert.equal(standaloneCalls, before + 1, label);
    assert.equal(nativeCalls, 0, label);
  }
});

test("nativeMcpExtensionFactory awaits async factories in order and surfaces rejections", async () => {
  const order = [];
  const slow = async () => { await new Promise((r) => setTimeout(r, 10)); order.push("slow"); };
  const next = () => { order.push("next"); };
  setBackendMcpNativeSessionProvider(() => ({ ok: true, factories: [slow, next] }));
  const pending = nativeMcpExtensionFactory("C:/work")({});
  assert.equal(typeof pending?.then, "function");
  await pending;
  assert.deepEqual(order, ["slow", "next"]);
  setBackendMcpNativeSessionProvider(() => ({ ok: true, factories: [async () => { throw new Error("boom"); }] }));
  await assert.rejects(Promise.resolve(nativeMcpExtensionFactory("C:/work")({})), /boom/);
  setBackendMcpNativeSessionProvider(undefined);
});

test("provider must be synchronous; uninstalling restores the legacy path", () => {
  assert.throws(() => setBackendMcpNativeSessionProvider(async () => ({})), /invalid/);
  assert.throws(() => setBackendMcpNativeSessionProvider("x"), /invalid/);
  setBackendMcpNativeSessionProvider(() => ({ ok: true, factories: [] })); setBackendMcpNativeSessionProvider(undefined);
  assert.equal(resolveBackendMcpNativeSession("C:/work").active, false);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendMcpGenerationOwner } from "./mcp-native-generation-lease.mjs";
import { createBackendMcpCredentialAuthority } from "./mcp-native-credential-authority.mjs";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
const safe = (error) => error instanceof Error && error.message === "MCP generation lease unavailable" && error.cause === undefined;

test("construction calls no process service, captures getters once and returns frozen opaque handles", () => {
  let gets = 0, calls = 0;
  const owner = createBackendMcpGenerationOwner({ get assertProcessOwner() { gets++; return () => { calls++; }; } });
  assert.equal(gets, 1); assert.equal(calls, 0); assert.equal(Object.isFrozen(owner), true);
  assert.throws(() => owner.captureLease(), safe); assert.equal(calls, 0);
  const lease = owner.beginGeneration(); assert.equal(calls, 1);
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease), ["assertOwner", "revoke"]);
  assert.equal(JSON.stringify(lease), "{}");
  const assertOwner = lease.assertOwner; assertOwner();
  owner.captureLease().assertOwner();
  assert.equal(calls, 4); assert.equal(gets, 1);
});

test("same-generation siblings remain independent; stale/revoked handles cannot poison a successor generation", () => {
  const owner = createBackendMcpGenerationOwner({ assertProcessOwner() {} });
  const first = owner.beginGeneration(), sibling = owner.captureLease();
  first.revoke(); first.revoke(); assert.throws(first.assertOwner, safe);
  sibling.assertOwner(); owner.captureLease().assertOwner();
  const successor = owner.beginGeneration();
  assert.throws(sibling.assertOwner, safe); sibling.revoke(); successor.assertOwner();
  owner.invalidate(); owner.invalidate(); assert.throws(successor.assertOwner, safe);
  assert.throws(() => owner.captureLease(), safe);
  const next = owner.beginGeneration();
  assert.throws(first.assertOwner, safe); assert.throws(sibling.assertOwner, safe); assert.throws(successor.assertOwner, safe);
  next.assertOwner();
});

test("process-authority failure revokes every current lease, never revives on restoration, and failed begin has no rollback", () => {
  let allowed = true;
  const owner = createBackendMcpGenerationOwner({ assertProcessOwner() { if (!allowed) throw Error("private-process-path-token"); } });
  const a = owner.beginGeneration(), b = owner.captureLease();
  allowed = false; assert.throws(a.assertOwner, safe);
  allowed = true; assert.throws(a.assertOwner, safe); assert.throws(b.assertOwner, safe);
  assert.throws(() => owner.captureLease(), safe);
  const c = owner.beginGeneration(); c.assertOwner();
  allowed = false; assert.throws(() => owner.beginGeneration(), safe);
  allowed = true; assert.throws(c.assertOwner, safe); owner.beginGeneration().assertOwner();
});

test("disposal is terminal/idempotent and cannot be undone by generation changes or cleanup", () => {
  const owner = createBackendMcpGenerationOwner({ assertProcessOwner() {} });
  const lease = owner.beginGeneration();
  owner.dispose(); owner.dispose(); owner.invalidate(); lease.revoke();
  assert.throws(lease.assertOwner, safe);
  assert.throws(() => owner.beginGeneration(), safe); assert.throws(() => owner.captureLease(), safe);
});

test("ownership callbacks cannot publish a lease after invalidation/disposal or swallowed reentrant verification", () => {
  for (const operation of ["invalidate", "dispose", "beginGeneration"]) {
    let trigger = false, owner;
    owner = createBackendMcpGenerationOwner({ assertProcessOwner() {
      if (trigger) { trigger = false; try { owner[operation](); } catch { /* Cannot undo fencing. */ } }
    } });
    const old = owner.beginGeneration(); trigger = true;
    assert.throws(old.assertOwner, safe);
    assert.throws(old.assertOwner, safe);
    assert.throws(() => owner.captureLease(), safe);
    if (operation !== "dispose") owner.beginGeneration().assertOwner();
  }
  let revokeLocal = false, local;
  const owner = createBackendMcpGenerationOwner({ assertProcessOwner() { if (revokeLocal) { revokeLocal = false; local.revoke(); } } });
  local = owner.beginGeneration(); const sibling = owner.captureLease();
  revokeLocal = true; assert.throws(local.assertOwner, safe); sibling.assertOwner();
});

test("strict constructor/synchronous authority contracts sanitize errors and consume rejected async services", async () => {
  for (const options of [undefined, null, [], {}, Object.create({ assertProcessOwner() {} }), { assertProcessOwner: 1 }, { assertProcessOwner() {}, fallback: true }]) {
    assert.throws(() => createBackendMcpGenerationOwner(options), safe);
  }
  assert.throws(() => createBackendMcpGenerationOwner({ get assertProcessOwner() { throw Error("private-service-getter"); } }), safe);
  for (const assertProcessOwner of [() => true, () => 0, () => Promise.reject(Error("private-async-owner")), () => { throw Error("private-owner"); }]) {
    const owner = createBackendMcpGenerationOwner({ assertProcessOwner });
    assert.throws(() => owner.beginGeneration(), safe); assert.throws(() => owner.captureLease(), safe);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("cooperative config ABA without an old hash check still rejects old authority/leases after a new generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-generation-aba-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = "https://example.invalid/mcp", userPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundled.json");
  await writeFile(userPath, JSON.stringify({ mcpServers: { fixture: { url } } })); await writeFile(bundledConfigPath, "{}");
  const original = await readFile(userPath);
  const owner = createBackendMcpGenerationOwner({ assertProcessOwner() {} });
  const lease = owner.beginGeneration();
  const prepared = await prepareBackendMcpConfigLoader({ agentDir: root, bundledConfigPath }); assert.equal(prepared.ok, true);
  const gate = createBackendMcpCredentialAuthority({ agentDir: root, bundledConfigPath, prepared, assertRuntimeOwner: lease.assertOwner });
  const identity = { namespace: "mcp__fixture", serverUrl: url };
  gate(identity);
  owner.invalidate(); // Mandatory coordinator fence BEFORE any cooperative writer.
  await writeFile(userPath, "{}"); await writeFile(userPath, original); // NO old gate invocation during the ABA.
  const current = owner.beginGeneration();
  assert.deepEqual(await readFile(userPath), original);
  assert.throws(() => gate(identity), (e) => e.message === "MCP credential authority unavailable" && e.cause === undefined);
  assert.throws(lease.assertOwner, safe);
  createBackendMcpCredentialAuthority({ agentDir: root, bundledConfigPath, prepared, assertRuntimeOwner: current.assertOwner })(identity);
  current.assertOwner();
});

test("a delayed preparation completion cannot resurrect a captured generation invalidated while awaiting", async () => {
  const owner = createBackendMcpGenerationOwner({ assertProcessOwner() {} });
  const captured = owner.beginGeneration();
  let finish;
  const preparation = new Promise((resolve) => { finish = resolve; });
  const completion = preparation.then(() => captured.assertOwner());
  owner.invalidate(); const current = owner.beginGeneration(); finish();
  await assert.rejects(completion, safe);
  current.assertOwner();
});

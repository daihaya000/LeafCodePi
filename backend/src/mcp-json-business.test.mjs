import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpJsonBusiness } from "./mcp-json-business.mjs";
import { markMcpBusinessEffect } from "../core/mcp-business-effects.mjs";
const auth = { name: "remote", authType: "bearer", credentialConfigured: true, credentialSource: "config", credentialStatus: "present", url: "https://user:PRIVATE@example.invalid/mcp?token=PRIVATE", configPath: "PRIVATE" };
const row = { ...auth, id: "remote", enabled: true, bundled: false, userConfigured: true, source: "http", headers: { Authorization: "PRIVATE" } };
const reload = { reloaded: 1, deferred: 2, failed: 1, errors: ["PRIVATE"] };
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-mcp-business-")), path = join(root, "ledger.json"), calls = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = { ok: true, auth, reload };
  const actions = { readMcpServerList: async () => ({ servers: [row] }), createMcpPresetAction: async input => ({ ok: true, name: input.preset, servers: [row], reload }), setMcpServerEnabledAction: async (name, enabled) => ({ ok: true, name, enabled, servers: [row] }), readMcpAuthStatus: async () => auth, saveMcpBearerAuthAction: async () => result, saveMcpHeadersAuthAction: async () => result, removeMcpAuthAction: async () => result,
    startMcpOAuthAuthAction: async () => ({ ok: true, name: "remote", status: "pending", authorizationUrl: "https://auth.example.invalid/start?state=fixture-state&code_challenge=challenge" }),
    completeMcpOAuthAuthAction: async () => ({ ok: true, status: "authenticated", auth: { ...auth, authType: "oauth", credentialSource: "oauth" }, reload }), ...overrides };
  for (const [key, fn] of Object.entries(actions)) if (typeof fn === "function") actions[key] = async (...args) => { calls.push([key, ...args]); return fn(...args); };
  const owner = createMcpJsonBusiness(actions, { ledgerPath: () => path });
  const input = (route, method, body, id = randomUUID()) => ({ route, method, url: "http://localhost/api/" + route, headers: { host: "localhost" }, authorized: true, operationId: id, ...(body === undefined ? {} : { body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)) }) });
  return { owner, actions, input, calls, root, path };
}
test("six methods plus bearer/headers/OAuth start/complete route only normalized inputs and deep redacted metadata", async t => {
  const f = fixture(t);
  for (const [route, method, body, action] of [["mcp", "GET", undefined, "readMcpServerList"], ["mcp", "POST", { preset: "notion" }, "createMcpPresetAction"], ["mcp/remote", "PATCH", { enabled: false }, "setMcpServerEnabledAction"], ["mcp/remote/auth", "GET", undefined, "readMcpAuthStatus"], ["mcp/remote/auth", "POST", { token: " private-token " }, "saveMcpBearerAuthAction"], ["mcp/remote/auth", "POST", { type: "headers", headers: { "x-key": " private-value " } }, "saveMcpHeadersAuthAction"], ["mcp/remote/auth", "POST", { type: "oauth" }, "startMcpOAuthAuthAction"], ["mcp/remote/auth", "POST", { type: "oauth", action: "complete", input: " private-code " }, "completeMcpOAuthAuthAction"], ["mcp/remote/auth", "DELETE", {}, "removeMcpAuthAction"]]) {
    const result = await f.owner(f.input(route, method, body)); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.calls.at(-1)[0], action); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    if (method !== "GET") assert.equal(result.body.operation.execution, "complete");
  }
  assert.deepEqual(f.calls.find(c => c[0] === "saveMcpBearerAuthAction")[2], { type: "bearer", token: "private-token" });
  assert.deepEqual(f.calls.find(c => c[0] === "removeMcpAuthAction")[2], { type: "bearer" });
  const ledger = readFileSync(f.path, "utf8"); for (const word of ["private-token", "private-value", "private-code", "remote", "Authorization", "oauth"]) assert.ok(!ledger.includes(word));
});
test("auth/Origin/bounds/name/query/body/privilege refusals precede owner callbacks, including TLS proxy authority", async t => {
  const f = fixture(t);
  for (const patch of [{ authorized: false }, { headers: { origin: "https://evil.invalid" } }, { headers: { origin: "http://undefined" } }, { headers: { "sec-fetch-site": "cross-site" } }, { body: new Uint8Array(4097) }]) assert.ok((await f.owner({ ...f.input("mcp/remote", "PATCH", { enabled: true }), ...patch })).status >= 400);
  for (const [route, method, body] of [["mcp/a%2Fb", "PATCH", { enabled: true }], ["mcp/..", "PATCH", { enabled: true }], ["mcp", "POST", { preset: "notion", command: "forged" }], ["mcp/remote", "PATCH", { enabled: true, token: "forged" }], ["mcp/remote/auth", "POST", { type: "headers", headers: { "x-a": "one", "X-A": "two" } }], ["mcp/remote/auth", "POST", { type: "oauth", action: "complete", input: "x", configPath: "forged" }], ["mcp/remote/auth", "DELETE", { type: "bearer", token: "forged" }]]) assert.equal((await f.owner(f.input(route, method, body))).status, 400);
  assert.equal((await f.owner({ ...f.input("mcp", "GET"), url: "http://localhost/api/mcp?path=forged" })).status, 400); assert.equal(f.calls.length, 0);
  assert.equal((await f.owner({ ...f.input("mcp/remote", "PATCH", { enabled: true }), headers: { host: "proxy.invalid", origin: "https://proxy.invalid" } })).status, 200);
});
test("partial typed 4xx becomes unknown; same ID survives a fresh dispatcher and never re-executes effects", async t => {
  let effects = 0;
  const f = fixture(t, { setMcpServerEnabledAction: async () => { markMcpBusinessEffect(); effects++; throw Object.assign(new Error("PRIVATE"), { status: 409 }); } });
  const input = f.input("mcp/remote", "PATCH", { enabled: false }), failed = await f.owner(input); assert.equal(failed.status, 503); assert.equal(failed.body.operation.execution, "unknown");
  const restarted = createMcpJsonBusiness(f.actions, { ledgerPath: () => f.path }); const duplicate = await restarted(input); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.operation.execution, "unknown"); assert.equal(effects, 1); assert.ok(!JSON.stringify(failed).includes("PRIVATE"));
});
test("pre-effect native OAuth/unknown target refusals stay complete, malformed/mismatched successes stay unknown", async t => {
  const f = fixture(t, { startMcpOAuthAuthAction: async () => { throw Object.assign(new Error("PRIVATE"), { status: 409 }); }, readMcpAuthStatus: async () => { throw Object.assign(new Error("PRIVATE"), { status: 404 }); }, setMcpServerEnabledAction: async () => ({ ok: true, name: "different", enabled: false, servers: [] }), saveMcpBearerAuthAction: async () => ({ ok: true, auth: { ...auth, name: "different" }, reload }) });
  const refused = await f.owner(f.input("mcp/remote/auth", "POST", { type: "oauth" })); assert.equal(refused.status, 409); assert.equal(refused.body.operation.execution, "complete");
  assert.equal((await f.owner(f.input("mcp/remote/auth", "GET"))).status, 404);
  for (const input of [f.input("mcp/remote", "PATCH", { enabled: false }), f.input("mcp/remote/auth", "POST", { token: "fixture" })]) { const result = await f.owner(input); assert.equal(result.status, 503); assert.equal(result.body.operation.execution, "unknown"); }
});
test("admission corruption, invalid IDs and Next role never reach SDK/config actions", async t => {
  const f = fixture(t); assert.equal((await f.owner(f.input("mcp", "POST", { preset: "notion" }, "bad"))).status, 400);
  writeFileSync(f.path, "corrupt"); const result = await f.owner(f.input("mcp", "POST", { preset: "notion" })); assert.equal(result.status, 503); assert.equal(result.body.operation.execution, "not-started"); assert.equal(f.calls.length, 0);
  const old = process.env.LEAFCODE_PI_PROCESS_ROLE; process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
  try { await assert.rejects(f.owner(f.input("mcp", "GET")), /owned by Backend/); } finally { if (old === undefined) delete process.env.LEAFCODE_PI_PROCESS_ROLE; else process.env.LEAFCODE_PI_PROCESS_ROLE = old; }
});
test("serial accepted work survives disconnect and duplicate does not repeat callbacks", async t => {
  let release, entered; const entering = new Promise(done => { entered = done; }), hold = new Promise(done => { release = done; });
  const f = fixture(t, { createMcpPresetAction: async () => { markMcpBusinessEffect(); entered(); await hold; return { ok: true, name: "notion", servers: [], reload }; } });
  const input = f.input("mcp", "POST", { preset: "notion" }), controller = new AbortController(), pending = f.owner({ ...input, signal: controller.signal });
  await entering; controller.abort(); const duplicate = f.owner(input); release(); assert.equal((await pending).status, 200); assert.equal((await duplicate).status, 409); assert.equal(f.calls.length, 1);
});

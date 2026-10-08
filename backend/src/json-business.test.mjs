import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
async function fixture(t, options = {}) {
  const token = randomBytes(32).toString("hex"), server = createBackendServer({ token, isReady: () => true, ...options });
  t.after(() => closeBackend(server)); const address = await listenBackend(server, 0);
  return { base: `http://127.0.0.1:${address.port}/internal/json-business`, headers: { authorization: `Bearer ${token}`,
    "x-leafcode-backend-protocol": "1", "x-leafcode-business-origin": "http://localhost", "x-leafcode-business-host": "localhost", "x-leafcode-business-authorized": "1" } };
}
const request = (url, options = {}) => fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(2000) });
test("business transport enforces auth, protocol, readiness, method, context and body bound before execution", async t => {
  let calls = 0;
  const f = await fixture(t, { jsonBusinessRequestAction: async () => { calls++; return { status: 200, headers: {}, body: { ok: true, directory: "repo" } }; } });
  assert.equal((await request(`${f.base}/git/init`, { method: "POST" })).status, 401);
  assert.equal((await request(`${f.base}/git/init`, { method: "POST", headers: { ...f.headers, "x-leafcode-backend-protocol": "2" } })).status, 409);
  assert.equal((await request(`${f.base}/git/init`, { headers: f.headers })).status, 405);
  assert.equal((await request(`${f.base}/not-owned`, { headers: f.headers })).status, 404);
  assert.equal((await request(`${f.base}/git/init`, { method: "POST", headers: { ...f.headers, "x-leafcode-business-origin": "bad" } })).status, 400);
  assert.equal((await request(`${f.base}/git/init`, { method: "POST", headers: f.headers, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal(calls, 0);
  const unavailable = await fixture(t, { isReady: () => false, jsonBusinessRequestAction: async () => { calls++; } });
  assert.equal((await request(`${unavailable.base}/git/init`, { method: "POST", headers: unavailable.headers })).status, 503);
  assert.equal(calls, 0);
});
test("Peer bearer is forwarded only to Peer-facing routes; WebUI import remains protected and Retry-After survives", async t => {
  const previous = process.env.LEAFCODE_PI_WEBUI_AUTH; process.env.LEAFCODE_PI_WEBUI_AUTH = "required";
  t.after(() => { if (previous === undefined) delete process.env.LEAFCODE_PI_WEBUI_AUTH; else process.env.LEAFCODE_PI_WEBUI_AUTH = previous; });
  let calls = 0;
  const f = await fixture(t, { jsonBusinessRequestAction: async input => {
    calls++; assert.equal(input.authorized, false); assert.equal(input.headers.authorization, "Bearer PEER-TOKEN"); assert.equal(input.headers.cookie, undefined);
    return { status: 429, headers: { "retry-after": "7" }, body: { error: "rate-limited" } };
  } });
  const headers = { ...f.headers, "x-leafcode-business-authorized": "0", "x-leafcode-business-peer-authorization": "Bearer PEER-TOKEN", cookie: "PRIVATE-COOKIE" };
  const result = await request(`${f.base}/peer-auth/list`, { headers }); assert.equal(result.status, 200); assert.equal((await result.json()).headers["retry-after"], "7");
  assert.equal((await request(`${f.base}/peer-auth/import`, { headers })).status, 403);
  assert.equal((await request(`${f.base}/accounts`, { headers })).status, 403); assert.equal(calls, 1);
});
test("definition transport routes named targets and rejects missing operation acknowledgement context before execution", async t => {
  let calls = 0;
  const f = await fixture(t, { jsonBusinessRequestAction: async input => {
    calls++; assert.equal(input.route, "skills/review%2Ffixture"); assert.match(input.operationId, /^[a-f0-9-]{36}$/);
    return { status: 400, headers: {}, body: { error: "invalid name" } };
  } });
  const target = `${f.base}/skills/review%2Ffixture`;
  assert.equal((await request(target, { method: "PATCH", headers: f.headers, body: "{}" })).status, 400); assert.equal(calls, 0);
  const result = await request(target, { method: "PATCH", headers: { ...f.headers, "x-leafcode-business-operation": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, body: "{}" });
  assert.equal(result.status, 200); assert.equal((await result.json()).status, 400); assert.equal(calls, 1);
});
test("owner receives only trusted ingress context and bytes; public DTO preserves error and 304", async t => {
  const f = await fixture(t, { jsonBusinessRequestAction: async input => {
    assert.equal(input.headers.authorization, undefined); assert.equal(input.headers.cookie, undefined);
    assert.equal(input.authorized, true);
    if (input.method === "GET") { assert.ok(input.signal instanceof AbortSignal); return { status: 304, headers: { etag: "etag", "set-cookie": "PRIVATE" }, body: null }; }
    assert.equal(input.signal, undefined); assert.equal(Buffer.from(input.body).toString(), "not-json");
    return { status: 500, headers: {}, body: { error: "restore failed", mergeSucceeded: true, restored: null, strandedOn: "main", token: "PRIVATE" } };
  } });
  const result = await request(`${f.base}/git/merge`, { method: "POST", headers: { ...f.headers, cookie: "PRIVATE" }, body: "not-json" });
  assert.equal(result.status, 200); assert.deepEqual((await result.json()).body, { error: "restore failed", mergeSucceeded: true, restored: null, strandedOn: "main" });
  const conditional = await request(`${f.base}/git/log`, { headers: f.headers });
  assert.deepEqual(await conditional.json(), { status: 304, headers: { etag: "etag" }, body: null });
});
test("owner exceptions and malformed results never leak secret messages", async t => {
  const f = await fixture(t, { jsonBusinessRequestAction: async () => { throw new Error("PRIVATE"); } });
  const result = await request(`${f.base}/git/log`, { headers: f.headers });
  assert.equal(result.status, 503); assert.ok(!(await result.text()).includes("PRIVATE"));
  const malformed = await fixture(t, { jsonBusinessRequestAction: async () => ({ status: 200, body: { token: "PRIVATE" } }) });
  const invalid = await request(`${malformed.base}/git/init`, { method: "POST", headers: malformed.headers });
  assert.equal(invalid.status, 503); assert.ok(!(await invalid.text()).includes("PRIVATE"));
});
test("read-only disconnect reaches owner signal, while mutation disconnect does not cancel an admitted write", async t => {
  let entered = false, cancelled = false;
  const f = await fixture(t, { jsonBusinessRequestAction: async input => {
    entered = true;
    await new Promise(resolve => input.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    return { status: 304, body: null, headers: {} };
  } });
  const controller = new AbortController(), pending = request(`${f.base}/git/log`, { headers: f.headers, signal: controller.signal }).catch(() => {});
  for (let i = 0; !entered && i < 100; i++) await delay(10);
  assert.equal(entered, true); controller.abort(); await pending;
  for (let i = 0; !cancelled && i < 100; i++) await delay(10);
  assert.equal(cancelled, true);
  let writeEntered = false, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const writes = await fixture(t, { jsonBusinessRequestAction: async input => {
    assert.equal(input.signal, undefined); writeEntered = true; await gate;
    return { status: 200, headers: {}, body: { ok: true, directory: "repo" } };
  } });
  const abortWrite = new AbortController(), lost = request(`${writes.base}/git/init`, { method: "POST", headers: writes.headers, body: "{}", signal: abortWrite.signal }).catch(() => {});
  for (let i = 0; !writeEntered && i < 100; i++) await delay(10);
  assert.equal(writeEntered, true); abortWrite.abort(); await lost; finish();
});

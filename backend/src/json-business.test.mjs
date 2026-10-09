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
test("session transport enforces 4KiB, authorized context and operation IDs for all four routes",async t=>{
 const previous=process.env.LEAFCODE_PI_WEBUI_AUTH;process.env.LEAFCODE_PI_WEBUI_AUTH="required";
 t.after(()=>{if(previous===undefined)delete process.env.LEAFCODE_PI_WEBUI_AUTH;else process.env.LEAFCODE_PI_WEBUI_AUTH=previous;});
 let calls=0;
 const f=await fixture(t,{jsonBusinessRequestAction:async input=>{calls++;assert.equal(input.signal,undefined);assert.equal(input.authorized,true);assert.equal(Buffer.from(input.body).toString(),"opaque bytes");return {status:409,headers:{"set-cookie":"PRIVATE"},body:{error:"busy",operation:{id:input.operationId,execution:"complete"},token:"PRIVATE"}};}});
 const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",headers={...f.headers,"x-leafcode-business-operation":id};
 for(const action of ["fork","revert","unrevert","promote"]){
  const url=`${f.base}/tasks/bot%3At/${action}`;
  assert.equal((await request(url,{headers})).status,405);
  assert.equal((await request(url,{method:"POST",headers:f.headers,body:"{}"})).status,400);
  assert.equal((await request(url,{method:"POST",headers:{...headers,"x-leafcode-business-authorized":"0"},body:"{}"})).status,403);
  assert.equal((await request(url,{method:"POST",headers,body:"x".repeat(4097)})).status,413);
  const result=await request(url,{method:"POST",headers,body:"opaque bytes"});assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:409,headers:{},body:{error:"busy",operation:{id,execution:"complete"}}});
 }
 assert.equal(calls,4);
});
test("compaction transport preserves escaped-focus budget and rejects oversized abort/malformed SDK success",async t=>{
 let calls=0;
 const f=await fixture(t,{jsonBusinessRequestAction:async input=>{
  calls++;assert.equal(input.signal,undefined);
  if(input.route.endsWith("/abort"))return {status:200,body:{task:{id:"t"}}};
  assert.ok(input.body.byteLength>4096);return {status:400,headers:{},body:{error:"owner focus validation",operation:{id:input.operationId,execution:"complete"}}};
 }});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},url=`${f.base}/tasks/t/compact`;
 assert.equal((await request(url,{method:"POST",headers,body:"x".repeat(192*1024+1)})).status,413);assert.equal((await request(url+"/abort",{method:"POST",headers,body:"x".repeat(4097)})).status,413);assert.equal(calls,0);
 const focus=JSON.stringify({customInstructions:"\u0000".repeat(32000)});const admitted=await request(url,{method:"POST",headers,body:focus});assert.equal(admitted.status,200);assert.equal((await admitted.json()).status,400);
 assert.equal((await request(url+"/abort",{method:"POST",headers,body:"{}"})).status,503);assert.equal(calls,2);
});
test("Goal transport distinguishes start/control budgets and nullable reads from malformed command success",async t=>{
 let calls=0;
 const f=await fixture(t,{jsonBusinessRequestAction:async input=>{calls++;if(input.method==="GET")return {status:200,headers:{},body:{loop:null}};if(input.body.length>4096)return {status:400,headers:{},body:{error:"opaque large start",operation:{id:input.operationId,execution:"complete"}}};return {status:200,headers:{},body:{loop:null,operation:{id:input.operationId,execution:"complete"}}};}});
 const url=`${f.base}/tasks/t/goal-loop`,headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"};
 assert.equal((await request(url,{method:"PATCH",headers,body:"x".repeat(4097)})).status,413);assert.equal(calls,0);
 assert.equal((await request(url,{method:"POST",headers:f.headers,body:"{}"})).status,400);assert.equal(calls,0);
 const read=await request(url,{headers:f.headers});assert.equal(read.status,200);assert.deepEqual((await read.json()).body,{loop:null});
 const start=await request(url,{method:"POST",headers,body:"x".repeat(4097)});assert.equal(start.status,200);assert.equal((await start.json()).status,400);
 assert.equal((await request(url,{method:"PATCH",headers,body:"{}"})).status,503);assert.equal(calls,3);
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

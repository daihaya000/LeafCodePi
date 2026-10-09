import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { request as httpRequest } from "node:http";
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
test("Bot routine transport admits CRUD/run separately and retains trusted selectors, byte bounds and failure snapshot",async t=>{
 const botId="11111111-0123-4321-abcd-eeeeeeeeeeee",routineId="22222222-0123-4321-abcd-eeeeeeeeeeee",routine={id:routineId,botId,name:"authored",prompt:"authored",schedule:"0 0 29 2 *",enabled:false,createdAt:"fixture",updatedAt:"fixture",failureCount:1,lastRunAt:null};let writes=0;
 const f=await fixture(t,{jsonBusinessRequestAction:async input=>{if(input.method==="GET")return {status:200,body:input.route.endsWith("routines")?{routines:[routine]}:{routine}};writes++;assert.equal(input.signal,undefined);assert.ok(input.operationId);return {status:500,body:{error:"failed",routine,operation:{id:input.operationId,execution:"unknown"}}};}});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},base=f.base+"/bots/"+botId+"/routines";
 for(const path of [base,base+"/"+routineId])assert.equal((await request(path,{headers:f.headers})).status,200);
 for(const [path,method,bound]of [[base,"POST",65536],[base+"/"+routineId,"PATCH",65536],[base+"/"+routineId,"DELETE",4096],[base+"/"+routineId+"/run","POST",4096]]){assert.equal((await request(path,{method,headers:f.headers,body:"{}"})).status,400);assert.equal((await request(path,{method,headers,body:"x".repeat(bound+1)})).status,413);const response=await request(path,{method,headers,body:"opaque"});assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,500);assert.equal(result.body.routine.enabled,false);}
 assert.equal(writes,4);
});
test("Bot Code transport keeps read context, opaque commands and per-route budgets separate",async t=>{
 let calls=0;const f=await fixture(t,{jsonBusinessRequestAction:async input=>{
  calls++;if(input.method==="GET"){assert.ok(input.operationId==null);return input.route.endsWith("code-session")?{status:200,body:{tasks:[],loops:{}}}:{status:200,body:{requests:[]}};}
  assert.equal(input.signal,undefined);assert.ok(input.operationId);assert.equal(Buffer.from(input.body).toString(),"opaque");
  return {status:409,body:{error:"owner refusal",operation:{id:input.operationId,execution:"complete"},token:"PRIVATE"}};
 }});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},id="11111111-0123-4321-abcd-eeeeeeeeeeee";
 for(const action of ["code-session","code-requests"]){const path=f.base+"/bots/"+id+"/"+action;assert.equal((await request(path,{headers:f.headers})).status,200);assert.equal((await request(path,{method:"POST",headers:f.headers,body:"{}"})).status,400);const result=await request(path,{method:"POST",headers,body:"opaque"});assert.equal(result.status,200);assert.ok(!JSON.stringify(await result.json()).includes("PRIVATE"));assert.equal((await request(path,{method:"POST",headers,body:"x".repeat(action==="code-session"?262145:4097)})).status,413);}
 const patch=await request(f.base+"/bots/"+id+"/code-session",{method:"PATCH",headers,body:"opaque"});assert.equal(patch.status,200);assert.equal(calls,5);
});
test("Bot conversation transport isolates three admitted writes, their bounds and deep Goal/tree DTO",async t=>{
 let calls=0;const f=await fixture(t,{jsonBusinessRequestAction:async input=>{
  calls++;assert.equal(input.signal,undefined);assert.ok(input.operationId);assert.equal(Buffer.from(input.body).toString(),"opaque 日本語");
  return {status:409,body:{error:"owner refusal",operation:{id:input.operationId,execution:"complete"},token:"PRIVATE"}};
 }});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},id="11111111-0123-4321-abcd-eeeeeeeeeeee";
 for(const action of ["prompt","abort","revert"]){
  const path=f.base+"/bots/"+id+"/"+action;assert.equal((await request(path,{headers})).status,405);
  assert.equal((await request(path,{method:"POST",headers:f.headers,body:"{}"})).status,400);
  if(action!=="prompt")assert.equal((await request(path,{method:"POST",headers,body:"x".repeat(4097)})).status,413);
  const response=await request(path,{method:"POST",headers,body:"opaque 日本語"});assert.equal(response.status,200);assert.ok(!JSON.stringify(await response.json()).includes("PRIVATE"));
 }
 assert.equal(calls,3);
 const malformed=await fixture(t,{jsonBusinessRequestAction:async()=>({status:200,body:{task:null,loop:{status:"queued"}}})});assert.equal((await request(malformed.base+"/bots/"+id+"/prompt",{method:"POST",headers:{...malformed.headers,"x-leafcode-business-operation":headers["x-leafcode-business-operation"]},body:"{}"})).status,503);
});
test("Bot lifecycle transport isolates opaque commands, read context, avatar bounds and public DTO",async t=>{
 let calls=0;const f=await fixture(t,{jsonBusinessRequestAction:async input=>{
  calls++;assert.equal(Boolean(input.signal),input.method==="GET");
  assert.equal(Boolean(input.operationId),input.method!=="GET");
  return {status:input.method==="GET"?404:409,body:{error:"owner refusal",...(input.operationId?{operation:{id:input.operationId,execution:"complete"}}:{}),token:"PRIVATE"}};
 }});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},id="11111111-0123-4321-abcd-eeeeeeeeeeee";
 assert.equal((await request(f.base+"/bots",{method:"POST",headers,body:"x".repeat(4097)})).status,413);
 const declaredStatus=await new Promise((resolve,reject)=>{const upload=httpRequest(f.base+"/bots/"+id,{method:"PATCH",headers:{...headers,"content-length":"4194305"}},response=>{response.resume();response.once("end",()=>resolve(response.statusCode));});upload.once("error",reject);upload.end();});assert.equal(declaredStatus,413);
 assert.equal((await request(f.base+"/bots",{method:"POST",headers:f.headers,body:"{}"})).status,400);assert.equal(calls,0);
 for(const [method,path] of [["GET","bots"],["GET","bots/"+id],["POST","bots"],["PATCH","bots/"+id],["DELETE","bots/"+id]]){
  const response=await request(f.base+"/"+path,{method,headers:method==="GET"?f.headers:headers,...(method==="GET"?{}:{body:"opaque 日本語"})});assert.equal(response.status,200);assert.ok(!JSON.stringify(await response.json()).includes("PRIVATE"));
 }
 assert.equal(calls,5);
 const invalid=await fixture(t,{jsonBusinessRequestAction:async()=>({status:200,body:{bot:{id}}})});assert.equal((await request(invalid.base+"/bots/"+id,{headers:invalid.headers})).status,503);
});
test("supervision transport scopes commands versus child reads and rejects malformed success",async t=>{
 let calls=0;const f=await fixture(t,{jsonBusinessRequestAction:async input=>{
  calls++;
  if(input.method==="GET"){assert.ok(input.signal);assert.equal(input.operationId,undefined);assert.ok(input.url.includes("since=bad"));return {status:200,headers:{},body:{runs:[]}};}
  assert.equal(input.signal,undefined);assert.ok(input.operationId);return {status:200,headers:{},body:{task:{id:"t",status:"working",supervisorBotId:"one",token:"PRIVATE"},operation:{id:input.operationId,execution:"complete"}}};
 }});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"};
 assert.equal((await request(`${f.base}/tasks/t/supervisor`,{method:"POST",headers,body:"x".repeat(4097)})).status,413);
 assert.equal((await request(`${f.base}/tasks/t/supervisor`,{method:"POST",headers:f.headers,body:"{}"})).status,400);assert.equal(calls,0);
 const write=await request(`${f.base}/tasks/t/supervisor`,{method:"POST",headers,body:'{"botId":null}'});assert.equal(write.status,200);assert.ok(!JSON.stringify(await write.json()).includes("PRIVATE"));
 const read=await request(`${f.base}/tasks/t/subagents?since=bad`,{headers:f.headers});assert.equal(read.status,200);assert.deepEqual((await read.json()).body,{runs:[]});assert.equal(calls,2);
 const malformed=await fixture(t,{jsonBusinessRequestAction:async()=>({status:200,body:{runs:[{}]}})});assert.equal((await request(`${malformed.base}/tasks/t/subagents`,{headers:malformed.headers})).status,503);
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
test("assistance transport scopes signals/budgets and rejects malformed successful DTO",async t=>{
 let calls=0;const f=await fixture(t,{jsonBusinessRequestAction:async input=>{
  calls++;assert.equal(Boolean(input.signal),input.route.endsWith("/progress"));
  return {status:400,body:{error:"owner validation",operation:{id:input.operationId,execution:"complete"}}};
 }});
 const headers={...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"};
 for(const [action,limit] of [["progress",32000],["title",32000],["next-action",320000],["permission/advice",4096]]){
  assert.equal((await request(`${f.base}/tasks/t/${action}`,{method:"POST",headers,body:"x".repeat(limit+1)})).status,413);
  const admitted=await request(`${f.base}/tasks/t/${action}`,{method:"POST",headers,body:"opaque 日本語"});assert.equal(admitted.status,200);assert.equal((await admitted.json()).status,400);
 }
 assert.equal(calls,4);
 const invalid=await fixture(t,{jsonBusinessRequestAction:async()=>({status:200,body:{answer:"missing fields"}})});assert.equal((await request(`${invalid.base}/tasks/t/progress`,{method:"POST",headers:{...invalid.headers,"x-leafcode-business-operation":headers["x-leafcode-business-operation"]},body:"{}"})).status,503);
});
test("only assistance progress cancellation reaches an admitted owner on HTTP disconnect",async t=>{
 let entered=false,cancelled=false;
 const f=await fixture(t,{jsonBusinessRequestAction:async input=>{entered=true;await new Promise(done=>input.signal.addEventListener("abort",()=>{cancelled=true;done();},{once:true}));return {status:502,body:{error:"cancelled",operation:{id:input.operationId,execution:"unknown"}}};}});
 const controller=new AbortController(),pending=request(`${f.base}/tasks/t/progress`,{method:"POST",headers:{...f.headers,"x-leafcode-business-operation":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},body:"{}",signal:controller.signal}).catch(()=>null);
 for(let i=0;i<100&&!entered;i++)await delay(5);assert.ok(entered);controller.abort();await pending;
 for(let i=0;i<100&&!cancelled;i++)await delay(5);assert.ok(cancelled);
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

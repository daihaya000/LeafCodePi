import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskConversationCommands } from "./task-conversation-command.mjs";
function fixture(t) { const root=mkdtempSync(join(tmpdir(),"task-conversation-command-")),path=join(root,"ledger.json");t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,path,create:()=>createTaskConversationCommands({ledgerPath:()=>path})}; }
test("a blocked prompt never queues another answer; duplicate admission is atomic across instances",async t=>{
 const {path,create}=fixture(t),operationId=randomUUID();let finish,calls=0;
 const prompt=create().run({operationId,handler:()=>{calls++;assert.equal(JSON.parse(readFileSync(path,"utf8")).operations[0].execution,"unknown");return new Promise(resolve=>finish=()=>resolve(Response.json({task:"PRIVATE-PROMPT"})));}});
 const duplicate=await create().run({operationId,handler:async()=>{calls++;return Response.json({ok:true});}});assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).operation.execution,"unknown");
 const answer=await create().run({operationId:randomUUID(),handler:async()=>Response.json({ok:true})});assert.equal(answer.status,200);assert.equal(calls,1);
 finish();assert.equal((await (await prompt).json()).operation.execution,"complete");assert.equal((await create().run({operationId,handler:async()=>{calls++;return Response.json({});}})).status,409);assert.equal(calls,1);assert.ok(!readFileSync(path,"utf8").includes("PRIVATE"));
 if(process.platform!=="win32")assert.equal(statSync(path).mode&0o777,0o600);
});
test("failure is sanitized unknown and restart cannot replay; refusal is complete, not a generation receipt",async t=>{
 const {path,create}=fixture(t),operationId=randomUUID();let calls=0;
 const reply=await create().run({operationId,handler:async()=>{calls++;throw new Error("PRIVATE approval/input/path");}});assert.equal(reply.status,503);assert.equal((await reply.json()).operation.execution,"unknown");
 const refused=await create().run({operationId:randomUUID(),handler:async()=>Response.json({error:"expired"},{status:404})});assert.equal((await refused.json()).operation.execution,"complete");
 assert.equal((await create().run({operationId,handler:async()=>{calls++;return Response.json({});}})).status,409);assert.equal(calls,1);assert.ok(!readFileSync(path,"utf8").includes("PRIVATE"));
});
test("bad ID, corrupt ledger and Next role refuse before handler/write",async t=>{
 const {root,path,create}=fixture(t);let calls=0;const handler=async()=>{calls++;return Response.json({ok:true});};
 assert.equal((await create().run({operationId:"bad",handler})).status,400);assert.deepEqual(readdirSync(root),[]);
 writeFileSync(path,"{");const denied=await create().run({operationId:randomUUID(),handler});assert.equal(denied.status,503);assert.equal((await denied.json()).operation.execution,"not-started");assert.equal(calls,0);
 const before=process.env.LEAFCODE_PI_PROCESS_ROLE;process.env.LEAFCODE_PI_PROCESS_ROLE="next";t.after(()=>{if(before===undefined)delete process.env.LEAFCODE_PI_PROCESS_ROLE;else process.env.LEAFCODE_PI_PROCESS_ROLE=before;});
 const other=fixture(t);await assert.rejects(other.create().run({operationId:randomUUID(),handler}),/owned by Backend/);assert.deepEqual(readdirSync(other.root),[]);assert.equal(calls,0);
});
test("recording failure after an accepted handler is unknown, not a rollback",async t=>{
 const {path,create}=fixture(t);let applied=false;
 const reply=await create().run({operationId:randomUUID(),handler:async()=>{applied=true;rmSync(path);mkdirSync(path);return Response.json({ok:true});}});
 assert.equal(applied,true);assert.equal(reply.status,503);assert.equal((await reply.json()).operation.execution,"unknown");
});
test("bounded concurrent ledger never evicts an unknown command to admit new work",async t=>{
 const {path,create}=fixture(t),unknown=randomUUID();
 const rows=[{id:unknown,execution:"unknown"},...Array.from({length:127},()=>({id:randomUUID(),execution:"complete"}))];writeFileSync(path,JSON.stringify({version:1,operations:rows}));
 assert.equal((await create().run({operationId:randomUUID(),handler:async()=>Response.json({ok:true})})).status,200);const retained=JSON.parse(readFileSync(path,"utf8")).operations;assert.equal(retained.length,128);assert.ok(retained.some(row=>row.id===unknown));
 writeFileSync(path,JSON.stringify({version:1,operations:retained.map(row=>({...row,execution:"unknown"}))}));let calls=0;const full=await create().run({operationId:randomUUID(),handler:async()=>{calls++;return Response.json({});}});assert.equal(full.status,503);assert.equal((await full.json()).operation.execution,"not-started");assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(path,"utf8")).operations.length,128);
});
test("malformed handler output stays unknown without retrying",async t=>{
 const {create}=fixture(t),id=randomUUID();let calls=0;const reply=await create().run({operationId:id,handler:async()=>{calls++;return new Response("PRIVATE not JSON");}});assert.equal(reply.status,503);assert.equal((await reply.json()).operation.execution,"unknown");assert.equal((await create().run({operationId:id,handler:async()=>{calls++;return Response.json({});}})).status,409);assert.equal(calls,1);
});

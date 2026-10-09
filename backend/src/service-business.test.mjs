import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
const id="11111111-0123-4321-abcd-eeeeeeeeeeee";
async function fixture(t, action, extra={}) {
 const token=randomBytes(32).toString("hex"),server=createBackendServer({token,isReady:()=>true,jsonBusinessRequestAction:action,...extra});t.after(()=>closeBackend(server));
 const address=await listenBackend(server,0);return{base:`http://127.0.0.1:${address.port}/internal/json-business`,headers:{authorization:`Bearer ${token}`,"x-leafcode-backend-protocol":"1","x-leafcode-business-origin":"http://localhost","x-leafcode-business-host":"localhost","x-leafcode-business-authorized":"1"}};
}
test("native service reads carry abort signals/no IDs and deeply project stored tasks and metadata",async t=>{
 const f=await fixture(t,async input=>{assert.equal(input.operationId,undefined);assert.ok(input.signal);return{status:200,body:input.route==="backend/tasks"?{source:"backend",tasks:[{id:"bot:b",kind:"bot",status:"archived",token:"PRIVATE"}]}:{url:"https://example.com/",title:"日本語",sourceUrl:"PRIVATE"}};});
 for(const route of["backend/tasks","link-preview"]){const reply=await fetch(f.base+"/"+route,{method:route==="link-preview"?"POST":"GET",headers:f.headers,...(route==="link-preview"?{body:'{"url":"opaque"}'}:{})});assert.equal(reply.status,200);assert.ok(!(await reply.text()).includes("PRIVATE"));}
});
test("native service transport refuses excess bodies and missing command IDs before owner effects",async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return{status:200,body:{translations:["日本語"],operation:{id,execution:"complete"}}};});
 for(const[route,headers,body,status]of[["link-preview",f.headers,"x".repeat(32769),413],["translation/reasoning",f.headers,"{}",400],["translation/reasoning",{...f.headers,"x-leafcode-business-operation":id},"x".repeat(65537),413]])assert.equal((await fetch(f.base+"/"+route,{method:"POST",headers,body})).status,status);
 assert.equal(calls,0);
});
test("translation receipts exclude nested capabilities; preview image cannot fall back to JSON",async t=>{
 let calls=0;
 const f=await fixture(t,async()=>{calls++;return{status:200,body:{translations:["日本語"],fallbacks:[false],operation:{id,execution:"complete",token:"PRIVATE"},token:"PRIVATE"}};});
 const response=await fetch(f.base+"/translation/reasoning",{method:"POST",headers:{...f.headers,"x-leafcode-business-operation":id},body:"{}"});assert.equal(response.status,200);assert.ok(!(await response.text()).includes("PRIVATE"));
 for(const method of ["GET","HEAD","POST"])assert.equal((await fetch(f.base+"/link-preview/image",{method,headers:f.headers})).status,404);
 assert.equal(calls,1);
});
test("accepted translation finishes after client disconnect with no propagated cancellation/retry",async t=>{
 let entered=false,finished=0,release;const gate=new Promise(r=>{release=r;});
 const f=await fixture(t,async input=>{assert.equal(input.signal,undefined);entered=true;await gate;finished++;return{status:200,body:{translations:["日本語"],operation:{id,execution:"complete"}}};});
 const request=httpRequest(f.base+"/translation/reasoning",{method:"POST",headers:{...f.headers,"x-leafcode-business-operation":id}});request.on("error",()=>{});request.end("{}");
 for(let i=0;i<100&&!entered;i++)await delay(5);assert.equal(entered,true);request.destroy();release();for(let i=0;i<100&&!finished;i++)await delay(5);assert.equal(finished,1);
});
test("unready native owner does not admit service work",async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;},{isReady:()=>false});assert.equal((await fetch(f.base+"/backend/tasks",{headers:f.headers})).status,503);assert.equal(calls,0);
});

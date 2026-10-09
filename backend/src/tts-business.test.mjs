import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
async function fixture(t, action) {
  const token=randomBytes(32).toString("hex"),server=createBackendServer({token,isReady:()=>true,jsonBusinessRequestAction:action});
  t.after(()=>closeBackend(server));const address=await listenBackend(server,0);
  return {base:`http://127.0.0.1:${address.port}/internal/json-business`,headers:{authorization:`Bearer ${token}`,"x-leafcode-backend-protocol":"1","x-leafcode-business-origin":"http://localhost","x-leafcode-business-host":"localhost","x-leafcode-business-authorized":"1"}};
}
const id="11111111-0123-4321-abcd-eeeeeeeeeeee";
test("TTS transport projects owner audio/voices, keeps generation opaque and requires receipt ID",async t=>{
  let calls=0;const f=await fixture(t,async input=>{
    calls++;
    if(input.method==="GET"){assert.equal(input.operationId,undefined);assert.ok(input.signal);return{status:200,body:{voices:[{id:"1",label:"日本語",metadata:"PRIVATE"}],url:"PRIVATE"}};}
    assert.equal(input.operationId,id);assert.equal(input.signal,undefined);assert.equal(new TextDecoder().decode(input.body),'{"text":"日本語","url":"ignored"}');
    return{status:200,body:{audio:{contentType:"audio/mpeg",base64:"AAEC/w==",url:"PRIVATE"},operation:{id,execution:"complete"},token:"PRIVATE"}};
  });
  const voiceReply=await fetch(f.base+"/settings/tts/voices",{headers:f.headers});assert.equal(voiceReply.status,200);assert.deepEqual((await voiceReply.json()).body,{voices:[{id:"1",label:"日本語"}]});
  const audioReply=await fetch(f.base+"/tts/synthesize",{method:"POST",headers:{...f.headers,"x-leafcode-business-operation":id},body:'{"text":"日本語","url":"ignored"}'});assert.equal(audioReply.status,200);const result=await audioReply.json();assert.equal(result.status,200);assert.equal(result.body.audio.base64,"AAEC/w==");assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  for(const [headers,body,status]of[[f.headers,"{}",400],[{...f.headers,"x-leafcode-business-operation":id},"x".repeat(16*1024+1),413]])assert.equal((await fetch(f.base+"/tts/synthesize",{method:"POST",headers,body})).status,status);
  assert.equal(calls,2);
});
test("accepted TTS runs after client disconnect without retry/cancellation propagation",async t=>{
  let started=false,completed=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,async input=>{assert.equal(input.signal,undefined);started=true;await gate;completed++;return{status:200,body:{audio:{contentType:"audio/wav",base64:"AQID"},operation:{id,execution:"complete"}}};});
  const req=httpRequest(f.base+"/tts/synthesize",{method:"POST",headers:{...f.headers,"x-leafcode-business-operation":id}});req.on("error",()=>{});req.end("{}");
  for(let i=0;i<100&&!started;i++)await delay(5);assert.equal(started,true);req.destroy();release();
  for(let i=0;i<100&&!completed;i++)await delay(5);assert.equal(completed,1);
});
test("malformed audio/private capability DTO is rejected by native ingress projection",async t=>{
 const f=await fixture(t,async()=>({status:200,body:{audio:{contentType:"text/html",base64:"PRIVATE"},operation:{id,execution:"complete"}}}));
 const reply=await fetch(f.base+"/tts/synthesize",{method:"POST",headers:{...f.headers,"x-leafcode-business-operation":id},body:"{}"});assert.equal(reply.status,503);assert.ok(!(await reply.text()).includes("PRIVATE"));
});

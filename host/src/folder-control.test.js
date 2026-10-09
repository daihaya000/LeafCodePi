import net from "node:net";
import assert from"node:assert/strict";import test from"node:test";import {request as httpRequest}from"node:http";
import{createLlamaControlServer,listenControlServer,closeControlServer}from"./llama-control-server.js";
import{HOST_FOLDER_PATH,HOST_FOLDER_HEADER}from"../../shared/host-folder-contract.mjs";
async function fixture(t,options={}){const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on("error",reject);s.listen(0,"127.0.0.1",()=>{const port=s.address().port;s.close(error=>error?reject(error):resolve(port));});});const server=createLlamaControlServer({controlPort:port,isLocalClientOrigin:()=>true,...options});await listenControlServer(server,port);t.after(()=>closeControlServer(server));return{base:"http://127.0.0.1:"+port+HOST_FOLDER_PATH,headers:{[HOST_FOLDER_HEADER]:"1"}};}
test("private Host dialog ingress enforces method/Host/Origin/header/body and projects successful selection",async t=>{
 let count=0;const f=await fixture(t,{onSelectFolder:async()=>{count++;return{path:"C:\\日本語",token:"PRIVATE",command:"PRIVATE"};}});
 for(const options of[{method:"GET",headers:f.headers},{method:"POST"},{method:"POST",headers:{...f.headers,origin:"http://allowed.browser"}}]){const r=await fetch(f.base,options);assert.ok(r.status>=400);assert.equal(count,0);}
 const invalidHost=await new Promise(resolve=>{const r=httpRequest(f.base,{method:"POST",headers:{...f.headers,host:"evil.example"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});r.end();});assert.equal(invalidHost,403);assert.equal(count,0);
 const tooLarge=await fetch(f.base,{method:"POST",headers:f.headers,body:"x".repeat(4097)});assert.equal(tooLarge.status,413);assert.equal(count,0);
 const chosen=await fetch(f.base,{method:"POST",headers:f.headers,body:'{"command":"ignored","path":"ignored"}'});assert.equal(chosen.status,200);assert.deepEqual(await chosen.json(),{path:"C:\\日本語"});assert.equal(count,1);assert.equal(chosen.headers.get("access-control-allow-origin"),null);
});
test("Host capability, cancellation, malformed success and private errors are honest without raw failures",async t=>{
 const unsupported=await fixture(t);assert.equal((await fetch(unsupported.base,{method:"POST",headers:unsupported.headers})).status,501);
 for(const [value,status]of [[{cancelled:true},200],[{},503]]){const f=await fixture(t,{onSelectFolder:()=>value});const r=await fetch(f.base,{method:"POST",headers:f.headers});assert.equal(r.status,status);const body=await r.json();if(status===503)assert.equal(body.execution,"unknown");}
 const f=await fixture(t,{onSelectFolder:()=>{throw new Error("PRIVATE command");}}),r=await fetch(f.base,{method:"POST",headers:f.headers});assert.equal(r.status,503);assert.ok(!JSON.stringify(await r.json()).includes("PRIVATE"));
});
test("accepted dialog survives disconnect and refuses a second window until completion",async t=>{
 let entered,finish;const started=new Promise(r=>entered=r),waiting=new Promise(r=>finish=r);let count=0;
 const f=await fixture(t,{onSelectFolder:async()=>{count++;entered();await waiting;return{cancelled:true};}});
 const connection=httpRequest(f.base,{method:"POST",headers:f.headers});connection.on("error",()=>{});connection.end();await started;connection.destroy();
 const busy=await fetch(f.base,{method:"POST",headers:f.headers});assert.equal(busy.status,409);assert.equal(count,1);
 finish();await new Promise(r=>setTimeout(r,25));const next=await fetch(f.base,{method:"POST",headers:f.headers});assert.equal(next.status,200);assert.equal(count,2);
});

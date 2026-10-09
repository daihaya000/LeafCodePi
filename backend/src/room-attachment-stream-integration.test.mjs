import assert from "node:assert/strict";
import test from "node:test";
import { fork, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const ROOT=fileURLToPath(new URL("../../",import.meta.url)),require=createRequire(new URL("../package.json",import.meta.url)),esbuild=require("esbuild");
test("Room attachments: real two-hop 256MiB, queued metadata cancellation, bounded memory and restart",{timeout:29000},async t=>{
 const root=mkdtempSync(join(tmpdir(),"leafcode-room-stream-")),data=join(root,"data"),agent=join(root,"agent"),rooms=join(data,"bots","rooms"),children=[];mkdirSync(agent,{recursive:true});mkdirSync(rooms,{recursive:true});
 t.after(async()=>{for(const c of children)if(c.exitCode===null && c.signalCode===null){const exit=new Promise(r=>c.once("exit",r));c.kill();await exit;}rmSync(root,{recursive:true,force:true});});
 const id="11111111-1111-4111-8111-111111111111",message="22222222-2222-4222-8222-222222222222",name=message+"-0.dat",image=message+"-0.png",size=8*1024*1024;
 mkdirSync(join(rooms,id,"files"),{recursive:true});mkdirSync(join(rooms,id,"images"));const payload=Buffer.from("日本語 Room attachment\n");writeFileSync(join(rooms,id,"files",name),payload);truncateSync(join(rooms,id,"files",name),size);
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=","base64");writeFileSync(join(rooms,id,"images",image),png);
 const record={id,name:"Fixture",members:[],createdAt:"fixture",updatedAt:"fixture",messages:[{id:message,role:"user",text:"fixture",createdAt:1,files:[{file:name,name:"日本語.txt",mimeType:"text/plain; charset=utf-8",size}]}]},metadata=join(rooms,id+".json");writeFileSync(metadata,JSON.stringify(record));const before=readFileSync(metadata);
 const build=spawnSync(process.execPath,[join(ROOT,"scripts/build-backend-runtime.mjs"),"--force"],{cwd:ROOT,encoding:"utf8",timeout:10000});assert.equal(build.status,0,build.stderr);
 const relay=join(root,"relay.mjs");await esbuild.build({entryPoints:[join(ROOT,"web/src/lib/task-file-stream-relay.ts")],outfile:relay,bundle:true,platform:"node",format:"esm",packages:"external",alias:{"@":join(ROOT,"web/src"),"@shared":join(ROOT,"shared"),"@backend-core":join(ROOT,"backend/core"),"@backend-runtime":join(ROOT,"backend/runtime-src")},logLevel:"silent"});
 const token="fixture-only-token-"+"x".repeat(32),samples={backend:[],next:[]},last={};
 async function launch(role,bundle,backendUrl=""){
  const child=fork(join(ROOT,"backend/src/task-file-stream-fixture.mjs"),[],{stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test",APPDATA:join(root,"roaming"),PI_CODING_AGENT_DIR:agent,LEAFCODE_PI_DATA_DIR:data,LEAFCODE_PI_DEFAULT_DIR:join(root,"workspaces"),LEAFCODE_PI_PROCESS_ROLE:role,LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_URL:backendUrl,LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:token,LEAFCODE_PI_PUSHOVER_TOKEN:"",LEAFCODE_PI_PUSHOVER_USER:"",FILE_FIXTURE_ROLE:role,FILE_FIXTURE_BUNDLE:bundle}});children.push(child);let errors="";child.stderr.setEncoding("utf8").on("data",c=>{errors+=c;});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Fixture timeout "+errors)),8000);child.on("message",s=>{last[role]=s;if(s.type==="sample")samples[role].push(s);if(s.type==="ready"){clearTimeout(timer);resolve({base:"http://127.0.0.1:"+s.port,child});}});child.once("exit",code=>{if(code!==0)reject(new Error("Fixture stopped "+errors));});});
 }
 let backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs")),frontend=await launch("next",relay,backend.base);
 const url=()=>frontend.base+`/api/bots/rooms/${id}/files/${name}`,get=(address,options={})=>fetch(address,{...options,headers:{authorization:`Bearer ${token}`,...options.headers}});
 const waitFor=async predicate=>{const until=Date.now()+3000;while(Date.now()<until){for(const c of children)if(c.connected && c.exitCode===null && c.signalCode===null)c.send("sample");await delay(25);if(predicate())return;}assert.fail("Room resource cleanup: "+JSON.stringify(last));};
 const idle=()=>last.backend.state.active===0&&last.backend.state.descriptors===0&&last.backend.state.metadataActive===0&&last.backend.state.metadataQueued===0&&last.next.state.active===0;
 assert.equal((await fetch(url())).status,401);const range=await get(url(),{headers:{range:"bytes=0-15"}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),payload.subarray(0,16));assert.equal(range.headers.get("cache-control"),"private, max-age=31536000, immutable");
 const head=await get(url(),{method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),String(size));assert.equal((await head.arrayBuffer()).byteLength,0);
 const thumbnail=await get(frontend.base+`/api/bots/rooms/${id}/images/${image}`);assert.equal(thumbnail.status,200);assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()),png);
 await waitFor(idle);const baseline={backend:last.backend.memory,next:last.next.memory};samples.backend.length=0;samples.next.length=0;
 let total=0;for(let round=0;round<8;round++)await Promise.all(Array.from({length:4},async()=>{const response=await get(url());assert.equal(response.status,200);const reader=response.body.getReader();for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;}reader.releaseLock();}));assert.equal(total,size*32);
 for(let n=0;n<32;n++){const response=await get(url()),reader=response.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();}await waitFor(idle);
 // Fill the bounded metadata gate, then cancel queued requests before they can acquire a file.
 writeFileSync(metadata,JSON.stringify({...record,padding:"x".repeat(7*1024*1024)}));
 const controllers=Array.from({length:24},()=>new AbortController());const pending=controllers.map(c=>get(url(),{method:"HEAD",signal:c.signal}));setTimeout(()=>controllers.forEach(c=>c.abort()),35);await Promise.allSettled(pending);await waitFor(idle);assert.ok(last.backend.state.peakMetadataActive<=2);assert.ok(last.backend.state.metadataBufferBytes<=16*1024*1024);
 writeFileSync(metadata,before);assert.deepEqual(readFileSync(metadata),before);
 const metrics={bytesTransferred:total,disconnects:32,metadataCancellationRequests:24,state:last.backend.state,proxyActive:last.next.state.active,peaks:{}};
 for(const role of ["backend","next"]){const delta=Object.fromEntries(["rss","heapUsed","external"].map(key=>[key,Math.max(...samples[role].map(s=>s.memory[key]))-baseline[role][key]]));metrics.peaks[role]=delta;assert.ok(delta.rss<128*1024*1024,role+" RSS "+JSON.stringify(delta));assert.ok(delta.heapUsed<64*1024*1024,role+" heap "+JSON.stringify(delta));assert.ok(delta.external<96*1024*1024,role+" buffers "+JSON.stringify(delta));}
 for(const c of [frontend.child,backend.child]){const exited=new Promise(r=>c.once("exit",r));c.kill();await exited;}
 backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs"));frontend=await launch("next",relay,backend.base);const reconnected=await get(url(),{headers:{range:"bytes=0-15"}});assert.equal(reconnected.status,206);assert.deepEqual(Buffer.from(await reconnected.arrayBuffer()),payload.subarray(0,16));await waitFor(idle);t.diagnostic(JSON.stringify(metrics));
});

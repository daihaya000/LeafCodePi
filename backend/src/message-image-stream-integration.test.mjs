import assert from "node:assert/strict";
import test from "node:test";
import { fork,spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";import { join } from "node:path";import { fileURLToPath } from "node:url";import { setTimeout as delay } from "node:timers/promises";import { createHash } from "node:crypto";
const ROOT=fileURLToPath(new URL("../../",import.meta.url)),require=createRequire(new URL("../package.json",import.meta.url)),esbuild=require("esbuild");
test("readonly message image:72MiB transcript,256MiB transfer,cancelled scan,Range,branch,restart,memory",{timeout:110000},async t=>{
 const root=mkdtempSync(join(tmpdir(),"leafcode-message-image-")),data=join(root,"data"),agent=join(root,"agent"),session=join(root,"s.jsonl"),children=[],samples={backend:[],next:[]},last={};mkdirSync(data);mkdirSync(agent);
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once("exit",r));child.kill();await exit;}rmSync(root,{recursive:true,force:true});});
 const size=2*1024*1024,bytes=Buffer.alloc(size),png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=","base64");png.copy(bytes);
 writeFileSync(session,JSON.stringify({type:"session",version:3,id:"s",cwd:root})+"\n"+JSON.stringify({type:"message",id:"a",parentId:null,message:{role:"user",content:[{type:"image",mimeType:"image/png",data:bytes.toString("base64")}]}})+"\n");
 let parent="a";for(let i=0;i<70;i++){const id="r"+i;appendFileSync(session,JSON.stringify({type:"message",id,parentId:parent,message:{role:"assistant",content:[{type:"text",text:"x".repeat(1024*1024)}]}})+"\n");parent=id;}
 appendFileSync(session,JSON.stringify({type:"compaction",id:"c",parentId:parent,firstKeptEntryId:"a",summary:"fixture"})+"\n");
 const digest=()=>createHash("sha256").update(readFileSync(session)).digest("hex"),before=digest();
 writeFileSync(join(data,"store.json"),JSON.stringify({version:1,projects:[],tasks:[{id:"task",kind:"code",status:"archived",directory:root,title:"fixture",sessionFile:session,sessionId:"s",createdAt:"fixture",updatedAt:"fixture"}]}));
 const built=spawnSync(process.execPath,[join(ROOT,"scripts/build-backend-runtime.mjs"),"--force"],{cwd:ROOT,encoding:"utf8",timeout:10000});assert.equal(built.status,0,built.stderr);
 const relay=join(root,"relay.mjs");await esbuild.build({entryPoints:[join(ROOT,"web/src/lib/task-file-stream-relay.ts")],outfile:relay,bundle:true,platform:"node",format:"esm",packages:"external",alias:{"@":join(ROOT,"web/src"),"@shared":join(ROOT,"shared"),"@backend-core":join(ROOT,"backend/core"),"@backend-runtime":join(ROOT,"backend/runtime-src")},logLevel:"silent"});
 const token="fixture"+"x".repeat(32);
 async function launch(role,bundle,backendUrl=""){const child=fork(join(ROOT,"backend/src/task-file-stream-fixture.mjs"),[],{stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test",APPDATA:join(root,"roaming"),PI_CODING_AGENT_DIR:agent,LEAFCODE_PI_DATA_DIR:data,LEAFCODE_PI_DEFAULT_DIR:join(root,"workspaces"),LEAFCODE_PI_PROCESS_ROLE:role,LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:"",LEAFCODE_PI_BACKEND_URL:backendUrl,LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:token,FILE_FIXTURE_ROLE:role,FILE_FIXTURE_BUNDLE:bundle}});children.push(child);let errors="";child.stderr.on("data",b=>errors+=b);return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||"fixture timeout")),10000);child.on("message",m=>{last[role]=m;samples[role].push(m);if(m.type==="ready"){clearTimeout(timer);resolve({base:"http://127.0.0.1:"+m.port,child});}});child.on("exit",code=>{clearTimeout(timer);if(code)reject(Error(errors||"fixture died"));});});}
 let backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs")),next=await launch("next",relay,backend.base);const path="/api/tasks/task/message-image?messageId=a&partId=msg-0-image-0",get=(path,options={})=>fetch(next.base+path,{...options,headers:{authorization:"Bearer "+token,...options.headers}});
 const idle=()=>last.backend?.state.active===0&&last.backend?.state.imageReaders===0&&last.backend?.state.imageDescriptors===0&&last.backend?.state.imageWaiters===0&&last.backend?.state.heldImages===0&&last.next?.state.active===0;
 async function settle(){for(let i=0;i<120;i++){for(const child of children)if(child.connected)child.send("sample");await delay(25);if(idle())return;}assert.fail(JSON.stringify(last));}
 assert.equal((await fetch(next.base+path)).status,401);
 const range=await get(path,{headers:{range:"bytes=1-17"}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(1,18));assert.equal(range.headers.get("cache-control"),"private, no-store");
 const head=await get(path,{method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),String(size));assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await get(path,{headers:{range:"bytes=999999999-"}})).status,416);
 await settle();const baseline={backend:last.backend.memory,next:last.next.memory};samples.backend=[];samples.next=[];
 let total=0;
 for(let n=0;n<32;n++)await Promise.all(Array.from({length:4},async()=>{const r=await get(path);assert.equal(r.status,200);const reader=r.body.getReader();for(;;){const p=await reader.read();if(p.done)break;total+=p.value.length;}reader.releaseLock();}));
 assert.equal(total,256*1024*1024);
 for(let i=0;i<32;i++){const r=await get(path),reader=r.body.getReader();await reader.read();await reader.cancel();}await settle();
 const controllers=Array.from({length:24},()=>new AbortController()),pending=controllers.map(c=>get(path,{method:"HEAD",signal:c.signal}));setTimeout(()=>controllers.forEach(c=>c.abort()),30);await Promise.allSettled(pending);await settle();assert.equal(digest(),before);
 const metrics={bytesTransferred:total,disconnects:32,scanCancellations:24,final:last.backend.state,proxyActive:last.next.state.active,peaks:{}};
 for(const role of["backend","next"]){const delta=Object.fromEntries(["rss","heapUsed","external"].map(key=>[key,Math.max(...samples[role].map(s=>s.memory[key]))-baseline[role][key]]));metrics.peaks[role]=delta;assert.ok(delta.rss<128*1024*1024,role+" RSS "+JSON.stringify(delta));assert.ok(delta.heapUsed<48*1024*1024,role+" heap "+JSON.stringify(delta));assert.ok(delta.external<96*1024*1024,role+" buffers "+JSON.stringify(delta));}
 assert.ok(last.backend.state.scanBufferBytes<=16*1024*1024);assert.ok(last.backend.state.peakIndexBytes<=8*1024*1024);assert.equal(last.backend.state.heldImageBytes,0);t.diagnostic(JSON.stringify(metrics));
 appendFileSync(session,JSON.stringify({type:"message",id:"other",parentId:null,message:{role:"user",content:"new branch"}})+"\n");assert.equal((await get(path)).status,404);await settle();
 for(const child of[next.child,backend.child]){const exit=new Promise(r=>child.once("exit",r));child.kill();await exit;}
 backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs"));next=await launch("next",relay,backend.base);assert.equal((await get(path)).status,404);
 appendFileSync(session,JSON.stringify({type:"custom",id:"restored",parentId:"c",customType:"test"})+"\n");const reconnect=await get(path,{headers:{range:"bytes=-16"}});assert.equal(reconnect.status,206);assert.deepEqual(Buffer.from(await reconnect.arrayBuffer()),bytes.subarray(-16));await settle();
});

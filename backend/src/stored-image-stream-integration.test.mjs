import assert from "node:assert/strict";
import test from "node:test";
import { fork, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
const ROOT=fileURLToPath(new URL("../../",import.meta.url)),require=createRequire(new URL("../package.json",import.meta.url)),esbuild=require("esbuild");
test("stored images real two-hop: 256MiB, Range, 64 cancellations, finite memory, restart/expired cache",{timeout:29000},async t=>{
 const root=mkdtempSync(join(tmpdir(),"leafcode-image-stream-")),data=join(root,"data"),agent=join(root,"agent"),children=[];mkdirSync(agent,{recursive:true});mkdirSync(data);
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const exit=new Promise(r=>c.once("exit",r));c.kill();await exit;}rmSync(root,{recursive:true,force:true});});
 const size=2*1024*1024,bytes=Buffer.alloc(size,123);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);const icon="data:image/png;base64,"+bytes.toString("base64"),version=createHash("sha1").update(icon).digest("base64url").slice(0,16),png=join(root,"fixture.png");writeFileSync(png,bytes);
 writeFileSync(join(data,"store.json"),JSON.stringify({version:1,projects:[{id:"p",name:"fixture",path:join(root,"workspace"),icon,createdAt:"fixture"}],tasks:[]}));
 const build=spawnSync(process.execPath,[join(ROOT,"scripts/build-backend-runtime.mjs"),"--force"],{cwd:ROOT,encoding:"utf8",timeout:10000});assert.equal(build.status,0,build.stderr);
 const relay=join(root,"relay.mjs");await esbuild.build({entryPoints:[join(ROOT,"web/src/lib/task-file-stream-relay.ts")],outfile:relay,bundle:true,platform:"node",format:"esm",packages:"external",alias:{"@":join(ROOT,"web/src"),"@shared":join(ROOT,"shared"),"@backend-core":join(ROOT,"backend/core"),"@backend-runtime":join(ROOT,"backend/runtime-src")},logLevel:"silent"});
 const token="fixture-only-token-"+"x".repeat(32),samples={backend:[],next:[]},last={};
 async function launch(role,bundle,backendUrl="",seed=true){
  const child=fork(join(ROOT,"backend/src/task-file-stream-fixture.mjs"),[],{stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test",APPDATA:join(root,"roaming"),PI_CODING_AGENT_DIR:agent,LEAFCODE_PI_DATA_DIR:data,LEAFCODE_PI_PROCESS_ROLE:role,LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_URL:backendUrl,LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:token,LEAFCODE_PI_PUSHOVER_TOKEN:"",LEAFCODE_PI_PUSHOVER_USER:"",FILE_FIXTURE_ROLE:role,FILE_FIXTURE_BUNDLE:bundle,FILE_FIXTURE_PREVIEW:role==="backend"&&seed?png:""}});children.push(child);let errors="";child.stderr.setEncoding("utf8").on("data",c=>{errors+=c;});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Fixture timeout "+errors)),8000);child.on("message",s=>{last[role]=s;if(s.type==="sample")samples[role].push(s);if(s.type==="ready"){clearTimeout(timer);resolve({base:"http://127.0.0.1:"+s.port,child});}});child.once("exit",code=>{if(code!==0)reject(new Error("Fixture stopped "+errors));});});
 }
 let backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs")),frontend=await launch("next",relay,backend.base);
 const urls=()=>[frontend.base+"/api/projects/p/icon?v="+version,frontend.base+"/api/link-preview/image?id="+"a".repeat(32)+"&url=http://PRIVATE/"],get=(url,options={})=>fetch(url,{...options,headers:{authorization:`Bearer ${token}`,...options.headers}});
 const waitIdle=async()=>{const until=Date.now()+3000;while(Date.now()<until){for(const c of children)if(c.connected)c.send("sample");await delay(25);const state=last.backend.state;if(state.active===0&&state.descriptors===0&&state.activePreviewFetches===0&&state.previewWaiters===0&&last.next.state.active===0)return;}assert.fail("Image cleanup "+JSON.stringify(last));};
 assert.equal((await fetch(urls()[0])).status,401);
 for(const url of urls()){
  const range=await get(url,{headers:{range:"bytes=1-65537"}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(1,65538));
  const head=await get(url,{method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),String(size));assert.equal((await head.arrayBuffer()).byteLength,0);
 }
 const fresh=await get(urls()[0],{method:"HEAD"});assert.equal(fresh.headers.get("cache-control"),"private, max-age=31536000, immutable");
 const stale=await get(frontend.base+"/api/projects/p/icon?v=old",{method:"HEAD"});assert.equal(stale.headers.get("cache-control"),"private, no-cache");
 const preview=await get(urls()[1],{method:"HEAD"});assert.equal(preview.headers.get("referrer-policy"),"no-referrer");assert.equal(preview.headers.get("cache-control"),"private, max-age=300");
 await waitIdle();const baseline={backend:last.backend.memory,next:last.next.memory};samples.backend.length=0;samples.next.length=0;
 let total=0;for(let n=0;n<32;n++)await Promise.all(urls().flatMap(url=>Array.from({length:2},async()=>{const response=await get(url);assert.equal(response.status,200);const reader=response.body.getReader();for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;}reader.releaseLock();})));assert.equal(total,256*1024*1024);
 for(let n=0;n<32;n++)for(const url of urls()){const response=await get(url),reader=response.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();}await waitIdle();
 const metrics={bytesTransferred:total,disconnects:64,state:last.backend.state,proxyActive:last.next.state.active,peaks:{}};
 for(const role of ["backend","next"]){const delta=Object.fromEntries(["rss","heapUsed","external"].map(key=>[key,Math.max(...samples[role].map(s=>s.memory[key]))-baseline[role][key]]));metrics.peaks[role]=delta;assert.ok(delta.rss<128*1024*1024,role+" RSS "+JSON.stringify(delta));assert.ok(delta.heapUsed<48*1024*1024,role+" heap "+JSON.stringify(delta));assert.ok(delta.external<96*1024*1024,role+" buffers "+JSON.stringify(delta));}
 for(const c of [frontend.child,backend.child]){const exited=new Promise(r=>c.once("exit",r));c.kill();await exited;}
 backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs"),"",false);frontend=await launch("next",relay,backend.base);
 const persisted=await get(urls()[0],{headers:{range:"bytes=-16"}});assert.equal(persisted.status,206);assert.deepEqual(Buffer.from(await persisted.arrayBuffer()),bytes.subarray(-16));
 assert.equal((await get(urls()[1])).status,404);assert.equal((await get(frontend.base+"/api/link-preview/image?id=http://PRIVATE/")).status,404);await waitIdle();t.diagnostic(JSON.stringify(metrics));
});

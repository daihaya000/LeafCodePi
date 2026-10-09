import assert from "node:assert/strict";
import test from "node:test";
import { fork, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BACKEND_PROTOCOL_HEADER } from "../../shared/backend-protocol.mjs";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const esbuild = require("esbuild");

test("512MiB two-hop file streaming: bounded memory, Range, auth and 60 disconnects leave no FD or request", { timeout: 29000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-file-stream-")), data = join(root,"data"), agent = join(root,"agent"), children = [];
  mkdirSync(data); mkdirSync(agent);
  t.after(async () => { for (const child of children) { if (child.exitCode === null) { const stopped = new Promise(r=>child.once("exit",r)); child.kill(); await stopped; } } rmSync(root,{recursive:true,force:true}); });
  const bytes = Buffer.from("RIFF0000WAVEfmt data samples"), size = 512*1024*1024;
  writeFileSync(join(root,"a.wav"),bytes); truncateSync(join(root,"a.wav"),size);
  writeFileSync(join(data,"store.json"),JSON.stringify({version:1,projects:[],tasks:[{id:"task",kind:"code",status:"idle",directory:root,title:"fixture",createdAt:"fixture",updatedAt:"fixture"}]}));
  const built=spawnSync(process.execPath,[join(ROOT,"scripts/build-backend-runtime.mjs"),"--force"],{cwd:ROOT,encoding:"utf8",timeout:10000}); assert.equal(built.status,0,built.stderr);
  const relay=join(root,"relay.mjs");
  await esbuild.build({entryPoints:[join(ROOT,"web/src/lib/task-file-stream-relay.ts")],outfile:relay,bundle:true,platform:"node",format:"esm",packages:"external",alias:{"@":join(ROOT,"web/src"),"@shared":join(ROOT,"shared"),"@backend-core":join(ROOT,"backend/core"),"@backend-runtime":join(ROOT,"backend/runtime-src")},logLevel:"silent"});
  const token="fixture-only-token-"+"x".repeat(32), samples={backend:[],next:[]}, last={};
  async function launch(role,bundle,backendUrl=""){
    const child=fork(join(ROOT,"backend/src/task-file-stream-fixture.mjs"),[],{stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test",APPDATA:join(root,"roaming"),PI_CODING_AGENT_DIR:agent,LEAFCODE_PI_DATA_DIR:data,LEAFCODE_PI_DEFAULT_DIR:join(root,"workspaces"),LEAFCODE_PI_PROCESS_ROLE:role,LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_URL:backendUrl,LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:token,LEAFCODE_PI_PUSHOVER_TOKEN:"",LEAFCODE_PI_PUSHOVER_USER:"",FILE_FIXTURE_ROLE:role,FILE_FIXTURE_BUNDLE:bundle}}); children.push(child);
    let stderr="";child.stderr.setEncoding("utf8").on("data",c=>{stderr+=c;});
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Fixture timeout: "+stderr)),8000);child.on("message",s=>{last[role]=s;if(s.type==="sample")samples[role].push(s);if(s.type==="ready"){clearTimeout(timer);resolve("http://127.0.0.1:"+s.port);}});child.once("exit",code=>{if(code!==0)reject(new Error("Fixture exit: "+stderr));});});
  }
  const backend=await launch("backend",join(ROOT,"backend/runtime/runtime.bundle.mjs"));
  const frontend=await launch("next",relay,backend);
  const front = (url, options = {}) => fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  const path="/api/tasks/task/media?path=a.wav", headers={authorization:`Bearer ${token}`,[BACKEND_PROTOCOL_HEADER]:"1","x-leafcode-business-origin":"http://localhost","x-leafcode-business-host":"localhost","x-leafcode-business-authorized":"1"};
  assert.equal((await fetch(backend+"/internal/file-stream/tasks/task/media?path=a.wav",{headers:{...headers,authorization:"Bearer invalid"}})).status,401);
  assert.equal((await fetch(backend+"/internal/file-stream/tasks/task/media?path=a.wav",{headers:{...headers,"x-leafcode-business-authorized":"0"}})).status,403);
  assert.equal((await fetch(backend+"/internal/file-stream/tasks/task%2Fescape/media?path=a.wav",{headers})).status,404);
  assert.equal((await front(frontend+path,{headers:{range:"bytes=999999999-"}})).status,416);
  const range=await front(frontend+path,{headers:{range:"bytes=3-7"}});assert.equal(range.status,206);assert.equal(range.headers.get("content-range"),`bytes 3-7/${size}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(3,8));
  const head=await front(frontend+path,{method:"HEAD",headers:{range:"bytes=1-3"}});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),String(size));assert.equal((await head.arrayBuffer()).byteLength,0);
  const missing=await front(frontend+"/api/tasks/task/media?path=missing.wav");assert.equal(missing.status,403);await missing.body.cancel();
  const waitFor=async(predicate)=>{const until=Date.now()+3000;while(Date.now()<until){for(const c of children)c.send("sample");await delay(25);if(predicate())return;}assert.fail("Resource cleanup timeout: "+JSON.stringify(last));};
  await waitFor(()=>last.backend.state.active===0&&last.backend.state.descriptors===0&&last.next.state.active===0);
  const baseline={backend:last.backend.memory,next:last.next.memory}; samples.backend.length=0;samples.next.length=0;
  // A stalled browser must not make either owner read the full 512MiB file into memory.
  const stalled=await front(frontend+path);await delay(250);const readAt=last.backend.state.bytesRead;await delay(200);assert.ok(last.backend.state.bytesRead-readAt<1024*1024,"Producer ignored backpressure");await stalled.body.cancel();
  for(let pass=0;pass<2;pass++){
    const response=await front(frontend+path);assert.equal(response.status,200);assert.equal(response.headers.get("content-length"),String(size));assert.equal(response.headers.has(BACKEND_PROTOCOL_HEADER),false);
    const reader=response.body.getReader();let total=0;for(;;){const item=await reader.read();if(item.done)break;if(total===0)assert.deepEqual(Buffer.from(item.value.subarray(0,12)),bytes.subarray(0,12));total+=item.value.byteLength;}reader.releaseLock();assert.equal(total,size);
    await waitFor(()=>last.backend.state.descriptors===0&&last.next.state.active===0);
  }
  for(let n=0;n<60;n++){const response=await front(frontend+path);const reader=response.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();}
  await waitFor(()=>last.backend.state.active===0&&last.backend.state.descriptors===0&&last.next.state.active===0);
  const evidence={bytesTransferred:size*2,disconnects:61,active:last.backend.state.active,descriptors:last.backend.state.descriptors,proxyActive:last.next.state.active,peaks:{}};
  for(const role of ["backend","next"]){assert.ok(samples[role].length>0);const delta=Object.fromEntries(["rss","heapUsed","external","arrayBuffers"].map(key=>[key,Math.max(...samples[role].map(s=>s.memory[key]))-baseline[role][key]]));evidence.peaks[role]=delta;assert.ok(delta.rss<128*1024*1024,role+" memory grew with file size: "+JSON.stringify(delta));assert.ok(delta.heapUsed<48*1024*1024,role+" heap grew with file size");assert.ok(delta.external<96*1024*1024,role+" external buffer grew with file size");}
  t.diagnostic(JSON.stringify(evidence));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { createServer, get } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { STREAM_TEST_ROOT as ROOT, buildStreamProductionApp } from "./stream-production-test-support.mjs";
import { runtimeAliases, runtimeExternals, assertBackendInputs } from "../../scripts/build-backend-runtime.mjs";
const require=createRequire(join(ROOT,"backend/package.json")),{build}=require("esbuild"),MIB=1024*1024,token="t".repeat(32);
test("actual Next production:512MiB profile,512MiB TTS,125sec Provider SSE,auth,cancel,recovery,restart,resources",{timeout:360000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),"lcp-generated-production-")),app=join(dir,"next"),data=join(dir,"data"),agent=join(dir,"agent"),children=[],streams=[],samples={backend:[],next:[]};
 for(const path of[app,data,agent,join(agent,"skills")])mkdirSync(path);
 const resource=join(agent,"skills/resource.bin"),entry=join(dir,"owner.ts"),owner=join(ROOT,"backend/runtime/generated-production.fixture-"+process.pid+".mjs");
 const chunk=randomBytes(8*MIB);writeFileSync(resource,chunk);for(let i=1;i<8;i++)appendFileSync(resource,chunk);
 writeFileSync(join(agent,"AGENTS.md"),"fixture-日本語");writeFileSync(join(agent,"auth.json"),"not-exported");
 let backend,next,base,sid,phase="build",engineCalls=0,engineActive=0,engineCancelled=0;const engineErrors=[];
 const audio=Buffer.alloc(65536,0x81),size=64*MIB;
 const engine=createServer(async(req,res)=>{
  engineCalls++;engineActive++;let closed=false,complete=false;
  const close=()=>{if(!closed){closed=true;engineActive--;if(!complete)engineCancelled++;}};res.once("close",close);
  try{
   const parts=[];for await(const b of req)parts.push(b);const body=JSON.parse(Buffer.concat(parts));assert.equal(body.language,"Japanese");assert.equal(body.voice,"fixture-voice");
   if(body.text==="hold")await delay(200);if(res.destroyed)return;
   res.writeHead(200,{"content-type":"audio/wav","content-length":body.text==="small"?4:size,"set-cookie":"PRIVATE"});
   if(body.text==="small"){complete=true;res.end(Buffer.from([0,1,2,255]));return;}
   for(let at=0;at<size&&!res.destroyed;at+=audio.length){if(!res.write(audio))await new Promise(r=>{const done=()=>{res.off("drain",done);res.off("close",done);r();};res.once("drain",done);res.once("close",done);});}
   if(!res.destroyed){complete=true;res.end();}
  }catch(error){engineErrors.push(String(error));res.destroy();}finally{if(res.writableFinished)close();}
 });
 await new Promise(r=>engine.listen(0,"127.0.0.1",r));
 writeFileSync(join(data,"tts.json"),JSON.stringify({enabled:true,url:"http://127.0.0.1:"+engine.address().port+"/v1/tts",voice:"fixture-voice"}));
 t.after(async()=>{await Promise.all(streams.map(close));for(const c of children.reverse())await stop(c);engine.closeAllConnections();await new Promise(r=>engine.close(r));rmSync(owner,{force:true});rmSync(dir,{recursive:true,force:true});});
 writeFileSync(entry,`export {openTaskFileStream,readTaskFileStreamDiagnostics} from ${JSON.stringify(join(ROOT,"backend/runtime-src/file-stream/task-files.ts"))};\nexport {openProviderLoginEvents} from ${JSON.stringify(join(ROOT,"backend/runtime-src/json-business/provider-auth-events.ts"))};\nexport {readProviderLoginStreamDiagnostics} from ${JSON.stringify(join(ROOT,"backend/runtime-src/json-business/provider-login-stream.ts"))};\nexport {getActiveProviderLogin} from ${JSON.stringify(join(ROOT,"backend/runtime-src/lib/pi/harness.ts"))};\nexport {ProviderLoginSession} from ${JSON.stringify(join(ROOT,"backend/runtime-src/lib/pi/auth-login.ts"))};\n`);
 const built=await build({bundle:true,platform:"node",format:"esm",logLevel:"silent",entryPoints:[entry],outfile:owner,alias:runtimeAliases(),external:runtimeExternals(),tsconfig:join(ROOT,"backend/tsconfig.runtime.json"),banner:{js:'import{createRequire as _require}from"node:module";const require=_require('+JSON.stringify(join(ROOT,"backend/package.json"))+');'},metafile:true});assertBackendInputs(built.metafile);
 const env={...process.env,NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",LEAFCODE_PI_DATA_DIR:data,PI_CODING_AGENT_DIR:agent,APPDATA:join(dir,"appdata"),LEAFCODE_PI_DEFAULT_DIR:join(dir,"workspaces"),LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:"",LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:token,LEAFCODE_PI_BACKEND_RUNTIME:""};
 t.diagnostic(JSON.stringify({productionBuild:await buildStreamProductionApp(app,env,children)}));
 async function launch(role,extra={}){
  const c=fork(join(ROOT,"backend/src",role==="backend"?"generated-production-stream-fixture.mjs":"next-production-stream-fixture.mjs"),[],{env:{...env,...extra,LEAFCODE_PI_PROCESS_ROLE:role,STREAM_PRODUCTION_ROLE:role,STREAM_PRODUCTION_BUNDLE:owner,STREAM_NEXT_PACKAGE:join(ROOT,"web/package.json"),STREAM_NEXT_APP:app},stdio:["ignore","pipe","pipe","ipc"]});children.push(c);
  let output="";for(const s of[c.stdout,c.stderr])s.on("data",b=>output=(output+b).slice(-20000));
  return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output||"fixture startup timeout")),15000);c.on("message",m=>{samples[role].push({...m,phase,time:Date.now()});if(m.type==="ready"){clearTimeout(timer);resolve({child:c,port:m.port});}});c.once("error",reject);c.once("exit",code=>{clearTimeout(timer);if(code)reject(Error(output));});});
 }
 async function stop(c){if(c.exitCode!==null||c.signalCode!==null)return;const exited=new Promise(r=>c.once("exit",r));if(c.connected)c.disconnect();await Promise.race([exited,delay(1000)]);if(c.exitCode===null&&c.signalCode===null){c.kill();await exited;}}
 const latest=role=>samples[role].at(-1)?.state;
 async function settled(n=0){for(let i=0;i<240;i++){const s=latest("backend");if(s?.file.active===0&&s.file.profileActive===0&&s.file.profileDescriptors===0&&s.file.profileDirectories===0&&s.file.profileCompressors===0&&s.file.profileMetadataBytes===0&&s.file.ttsActive===0&&s.file.ttsReaders===0&&s.file.ttsHeldChunkBytes===0&&s.provider.active===n&&s.provider.readers===n&&s.provider.subscriptions===n&&latest("next")?.active===n&&engineActive===0)return;await delay(25);}assert.fail(JSON.stringify({backend:latest("backend"),next:latest("next"),engineActive}));}
 const headers=()=>({authorization:"Bearer "+token,origin:base});
 const profile=(options={})=>fetch(base+"/api/profile",{...options,headers:{...headers(),...options.headers}});
 const tts=(text="clip",options={})=>fetch(base+"/api/tts/synthesize",{method:"POST",...options,headers:{...headers(),"content-type":"application/json",...options.headers},body:JSON.stringify({text})});
 const replay=id=>fetch("http://127.0.0.1:"+backend.port+"/internal/file-stream/tts/synthesize",{method:"POST",headers:{authorization:"Bearer "+token,"x-leafcode-backend-protocol":"1","x-leafcode-business-origin":"http://localhost","x-leafcode-business-host":"localhost","x-leafcode-business-authorized":"1","x-leafcode-business-operation":id},body:'{"text":"FORGED"}'});
 async function open(selected=sid,extra={}){
  const c=new AbortController(),r=await fetch(base+"/api/providers/fixture/login/events?sessionId="+selected,{signal:c.signal,headers:{...headers(),...extra}});assert.equal(r.status,200);assert.equal(r.headers.has("x-leafcode-backend-protocol"),false);assert.equal(r.headers.has("set-cookie"),false);
  const s={c,reader:r.body.getReader(),bytes:0,text:"",pings:0,error:null,stopped:false},decoder=new TextDecoder();
  s.work=(async()=>{try{for(;;){const p=await s.reader.read();if(p.done)break;s.bytes+=p.value.length;const text=decoder.decode(p.value,{stream:true});s.pings+=(text.match(/: ping/g)??[]).length;s.text=(s.text+text).slice(-256000);}}catch(e){if(!s.stopped)s.error=String(e);}finally{s.reader.releaseLock();}})();streams.push(s);return s;
 }
 async function text(s,needle){for(let i=0;i<400;i++){if(s.text.includes(needle))return;await delay(10);}assert.fail(needle+":"+s.text.slice(-500));}
 async function close(s){s.stopped=true;s.c.abort();await s.reader.cancel().catch(()=>{});await s.work;}
 async function hash(){const h=createHash("sha256");for await(const b of createReadStream(resource))h.update(b);return h.digest("hex");}
 backend=await launch("backend");sid=latest("backend").provider.sid;next=await launch("next",{LEAFCODE_PI_BACKEND_URL:"http://127.0.0.1:"+backend.port});base="http://127.0.0.1:"+next.port;
 phase="warm";
 for(const path of["/api/profile","/api/providers/fixture/login/events?sessionId="+sid])assert.equal((await fetch(base+path)).status,401);
 assert.equal((await fetch(base+"/api/tts/synthesize",{method:"POST",headers:{"content-type":"application/json"},body:'{"text":"small"}'})).status,401);
 assert.equal(engineCalls,0);assert.equal((await profile({headers:{origin:"https://foreign.test"}})).status,403);assert.equal((await tts("small",{headers:{origin:"https://foreign.test"}})).status,403);assert.equal(engineCalls,0);
 const head=await profile({method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers.get("accept-ranges"),"none");assert.equal((await head.arrayBuffer()).byteLength,0);
 const range=await profile({headers:{range:"bytes=0-3","if-range":"ignored"}});assert.equal(range.status,200);assert.equal(range.headers.get("content-range"),null);await range.body.cancel();
 const warm=await tts("small",{headers:{range:"bytes=0-0","if-range":"ignored"}});assert.equal(warm.status,200);assert.deepEqual([...new Uint8Array(await warm.arrayBuffer())],[0,1,2,255]);assert.equal(warm.headers.get("content-length"),null);assert.equal(warm.headers.get("accept-ranges"),"none");assert.equal(warm.headers.get("set-cookie"),null);const completeId=warm.headers.get("x-leafcode-tts-operation");assert.equal((await replay(completeId)).status,409);
 const first=await open();await text(first,"fixture prompt");await text(first,"callbackUrl");await close(first);await settled();assert.equal(latest("backend").provider.loginAborted,false);
 const before=await hash(),baseline={backend:samples.backend.at(-1).memory,next:samples.next.at(-1).memory},start={backend:samples.backend.length,next:samples.next.length};
 phase="profile";let profileBytes=0;
 for(let round=0;round<4;round++)await Promise.all(Array.from({length:2},async()=>{const r=await profile();assert.equal(r.status,200);assert.equal(r.headers.get("content-type"),"application/gzip");assert.equal(r.headers.get("content-length"),null);assert.equal(r.headers.has("x-leafcode-backend-protocol"),false);const reader=r.body.getReader();try{for(;;){const p=await reader.read();if(p.done)break;profileBytes+=p.value.length;}}finally{reader.releaseLock();}}));
 assert.ok(profileBytes>512*MIB);await settled();const readBeforeCuts=latest("backend").file.profileBytesRead;
 for(let i=0;i<32;i++){const r=await profile(),reader=r.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();}await settled();assert.ok(latest("backend").file.profileBytesRead-readBeforeCuts<32*2*MIB,"disconnect must not drain archive sources");
 const cuts=Array.from({length:16},()=>new AbortController()),pending=cuts.map(c=>profile({signal:c.signal}));setTimeout(()=>cuts.forEach(c=>c.abort()),10);await Promise.allSettled(pending);await settled();assert.equal(await hash(),before);
 phase="tts";let audioBytes=0;
 for(let round=0;round<4;round++)await Promise.all(Array.from({length:2},async()=>{const r=await tts();assert.equal(r.status,200);const reader=r.body.getReader();try{for(;;){const p=await reader.read();if(p.done)break;audioBytes+=p.value.length;assert.equal(p.value[0],0x81);}}finally{reader.releaseLock();}}));assert.equal(audioBytes,512*MIB);
 let cancelledId;for(let i=0;i<32;i++){const r=await tts();assert.equal(r.status,200);cancelledId=r.headers.get("x-leafcode-tts-operation");const reader=r.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();await settled();}assert.equal((await replay(cancelledId)).status,409);
 const c=new AbortController(),callsBefore=engineCalls,attempt=tts("hold",{signal:c.signal});for(let i=0;i<100&&engineCalls===callsBefore;i++)await delay(5);assert.equal(engineCalls,callsBefore+1);c.abort();await attempt.catch(()=>{});await settled();
 const ledger=JSON.parse(readFileSync(join(data,"tts-synthesis-command.json"),"utf8"));assert.equal(ledger.operations.find(r=>r.id===completeId).execution,"complete");assert.equal(ledger.operations.find(r=>r.id===cancelledId).execution,"unknown");for(const secret of["fixture-voice","FORGED","127.0.0.1"])assert.ok(!JSON.stringify(ledger).includes(secret));assert.deepEqual(engineErrors,[]);
 phase="provider";for(let i=0;i<32;i++){const s=await open();await text(s,"fixture prompt");await close(s);}await settled();
 const one=await open(),two=await open();await text(one,"fixture prompt");await text(two,"fixture prompt");await settled(2);
 const longStart={backend:samples.backend.length,next:samples.next.length};backend.child.send({type:"producer",interval:5,bytes:32700});const began=Date.now();await delay(125000);const elapsed=Date.now()-began;
 assert.ok(one.bytes>128*MIB&&two.bytes>128*MIB);assert.ok(one.pings>=8&&two.pings>=8);assert.equal(one.error,null);assert.equal(two.error,null);await close(one);await close(two);await settled();
 const emitted=latest("backend").provider.emitted;await delay(100);assert.ok(latest("backend").provider.emitted>emitted);assert.equal(latest("backend").provider.loginAborted,false);assert.ok(latest("backend").provider.historyEntries<=7);assert.ok(latest("backend").provider.historyBytes<512*1024);
 const slow=await new Promise((resolve,reject)=>{const req=get(base+"/api/providers/fixture/login/events?sessionId="+sid,{headers:headers()},res=>{res.pause();resolve({req,res});});req.on("error",reject);});await settled(1);backend.child.send({type:"producer",interval:1,bytes:32700});for(let i=0;i<500&&latest("backend").provider.active;i++)await delay(100);assert.equal(latest("backend").provider.active,0);slow.req.destroy();slow.res.destroy();await settled();backend.child.send({type:"producer",interval:0});
 const recovered=await open(sid,{"last-event-id":"old"});await text(recovered,"fixture prompt");await text(recovered,"callbackUrl");await close(recovered);await settled();
 const completing=await open();await text(completing,"fixture prompt");backend.child.send({type:"complete"});await text(completing,'"ok":true');await completing.work;await settled();assert.equal(latest("backend").provider.answered,true);assert.equal(latest("backend").provider.loginAborted,false);
 const done=await open();await done.work;assert.match(done.text,/event: done/);assert.ok(!done.text.includes("event: prompt"));assert.ok(!done.text.includes("isolated-fixture-code"));await settled();
 for(const key of["active","subscriptions","queuedBytes","heartbeats","stallTimers","readers","drainWaiters","listeners"])assert.equal(latest("backend").provider[key],0,key);
 const metrics={profileBytes,audioBytes,elapsed,providerBytes:one.bytes+two.bytes,heartbeats:[one.pings,two.pings],disconnects:{profile:32,inventory:16,tts:32,headerWait:1,provider:32},engineCalls,engineCancelled,engineActive,final:latest("backend"),next:latest("next"),peaks:{},steadyHeap:{}};
 for(const role of["backend","next"]){const measured=samples[role].slice(start[role]),delta=Object.fromEntries(["rss","heapUsed","external"].map(k=>[k,Math.max(...measured.map(s=>s.memory[k]))-baseline[role][k]]));metrics.peaks[role]=delta;const heapPeak=measured.reduce((a,b)=>a.memory.heapUsed>b.memory.heapUsed?a:b);t.diagnostic(JSON.stringify({role,heapPeakPhase:heapPeak.phase,heapPeak:heapPeak.memory,baseline:baseline[role],delta}));assert.ok(delta.rss<128*MIB,role+" RSS "+JSON.stringify(delta));assert.ok(delta.heapUsed<48*MIB,role+" heap "+JSON.stringify(delta));assert.ok(delta.external<96*MIB,role+" buffers "+JSON.stringify(delta));const long=samples[role].slice(longStart[role]),early=Math.min(...long.slice(200,800).map(s=>s.memory.heapUsed)),late=Math.min(...long.slice(-800).map(s=>s.memory.heapUsed));metrics.steadyHeap[role]=late-early;assert.ok(late-early<8*MIB,role+" growing retained heap "+(late-early));}
 t.diagnostic(JSON.stringify(metrics));
 phase="restart";const oldSid=sid;await stop(next.child);await stop(backend.child);writeFileSync(resource,Buffer.from([0,1,2,3,254,255]));backend=await launch("backend",{STREAM_PROVIDER_EMPTY:"1"});next=await launch("next",{LEAFCODE_PI_BACKEND_URL:"http://127.0.0.1:"+backend.port});base="http://127.0.0.1:"+next.port;
 const oldCalls=engineCalls;assert.equal((await replay(completeId)).status,409);assert.equal((await replay(cancelledId)).status,409);assert.equal(engineCalls,oldCalls);assert.deepEqual([...new Uint8Array(await(await tts("small")).arrayBuffer())],[0,1,2,255]);
 const archive=JSON.parse(gunzipSync(Buffer.from(await(await profile()).arrayBuffer())).toString());assert.equal(archive.format,"leafcode-pi-profile");assert.equal(archive.version,1);assert.deepEqual(Buffer.from(archive.files["agent/skills/resource.bin"],"base64"),Buffer.from([0,1,2,3,254,255]));assert.equal(Buffer.from(archive.files["agent/AGENTS.md"],"base64").toString(),"fixture-日本語");assert.equal(archive.files["agent/auth.json"],undefined);assert.equal(typeof archive.modes["agent/skills/resource.bin"],"number");
 const stale=await open(oldSid);await stale.work;assert.match(stale.text,/"ok":false/);assert.ok(!stale.text.includes("fixture prompt"));await settled();
 await stop(next.child);await stop(backend.child);backend=await launch("backend");sid=latest("backend").provider.sid;assert.notEqual(sid,oldSid);next=await launch("next",{LEAFCODE_PI_BACKEND_URL:"http://127.0.0.1:"+backend.port});base="http://127.0.0.1:"+next.port;const fresh=await open();await text(fresh,"fixture prompt");await close(fresh);await settled();assert.deepEqual(engineErrors,[]);
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
test("remaining services work in a Webless real Backend and retain no-replay across process restart",{timeout:29000},async t=>{
 const fixture=mkdtempSync(join(tmpdir(),"leafcode-service-independent-")),backend=join(fixture,"backend"),data=join(fixture,"data"),agent=join(fixture,"agent");let child;
 async function stop(){if(child&&child.exitCode===null){const exited=new Promise(r=>child.once("exit",r));child.kill();await exited;}child=undefined;}
 t.after(async()=>{await stop();rmSync(fixture,{recursive:true,force:true});});mkdirSync(backend);mkdirSync(data);mkdirSync(agent);
 for(const path of["src","core","runtime-src","types","package.json","package-lock.json","tsconfig.json","tsconfig.runtime.json"])cpSync(join(ROOT,"backend",path),join(backend,path),{recursive:true});
 symlinkSync(join(ROOT,"backend","node_modules"),join(backend,"node_modules"),process.platform==="win32"?"junction":"dir");
 cpSync(join(ROOT,"shared"),join(fixture,"shared"),{recursive:true});mkdirSync(join(fixture,"scripts"));cpSync(join(ROOT,"scripts","build-backend-runtime.mjs"),join(fixture,"scripts","build-backend-runtime.mjs"));
 for(const path of["leafcode-subagents/src/api/background-work.ts","leafcode-todowrite/visibility.ts"]){const target=join(fixture,"extensions",path);mkdirSync(dirname(target),{recursive:true});cpSync(join(ROOT,"extensions",path),target);}
 assert.equal(existsSync(join(fixture,"web")),false);
 const built=spawnSync(process.execPath,[join(fixture,"scripts","build-backend-runtime.mjs"),"--force"],{cwd:fixture,encoding:"utf8",timeout:10000});assert.equal(built.status,0,built.stderr||built.error?.message);
 const rows=[{id:"code",kind:"code",status:"archived",title:"保存済み日本語",directory:fixture,createdAt:"fixture",updatedAt:"fixture",token:"PRIVATE"},{id:"bot:b",kind:"bot",status:"idle",title:"Bot 日本語",directory:fixture,createdAt:"fixture",updatedAt:"fixture",token:"PRIVATE"}];
 writeFileSync(join(data,"store.json"),JSON.stringify({version:1,projects:[{id:"project",rootPath:fixture,name:"Fixture",archived:true}],tasks:rows}));
 let hostCalls=0,lastBody;const host=createServer((req,res)=>{let raw="";req.setEncoding("utf8");req.on("data",c=>{raw+=c;});req.on("end",()=>{hostCalls++;assert.equal(req.url,"/translation/translate");lastBody=JSON.parse(raw);assert.deepEqual(Object.keys(lastBody),["texts"]);const text=JSON.stringify({translations:lastBody.texts.map(s=>"訳:"+s),fallbacks:lastBody.texts.map(()=>false),overridden:lastBody.texts.map(()=>false),token:"PRIVATE"});res.writeHead(200,{"content-type":"application/json"});res.end(text);});});
 await new Promise(r=>host.listen(0,"127.0.0.1",r));t.after(async()=>{host.closeAllConnections();await new Promise(r=>host.close(r));});
 const token=randomBytes(32).toString("hex"),headers={authorization:`Bearer ${token}`,"x-leafcode-backend-protocol":"1","content-type":"application/json","x-leafcode-business-origin":"http://localhost","x-leafcode-business-host":"localhost","x-leafcode-business-authorized":"1"};
 async function launch(){let out="",err="";child=spawn(process.execPath,[join(backend,"src","entry.mjs")],{cwd:fixture,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"test",PI_CODING_AGENT_DIR:agent,LEAFCODE_PI_DATA_DIR:data,LEAFCODE_PI_DEFAULT_DIR:join(fixture,"workspaces"),APPDATA:join(fixture,"roaming"),LEAFCODE_PI_BACKEND_PORT:"0",LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_BACKEND_RUNTIME:"1",LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE:join(backend,"runtime","runtime.bundle.mjs"),LEAFCODE_PI_PROCESS_ROLE:"backend",LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_MCP_NATIVE:"",LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_HOST_CONTROL_URL:`http://127.0.0.1:${host.address().port}`,LEAFCODE_PI_PUSHOVER_TOKEN:"",LEAFCODE_PI_PUSHOVER_USER:""}});
  child.stdout.setEncoding("utf8").on("data",c=>{out+=c;});child.stderr.setEncoding("utf8").on("data",c=>{err+=c;});const deadline=Date.now()+10000;let base;
  while(Date.now()<deadline&&child.exitCode===null){for(const line of out.split(/\r?\n/)){try{const value=JSON.parse(line);if(value.type==="backend_listening")base=`http://127.0.0.1:${value.port}`;}catch{}}
   if(base){const health=await fetch(base+"/internal/health",{headers,signal:AbortSignal.timeout(2000)});if((await health.json()).ready)return base;}await delay(25);
  }throw new Error("Backend startup failed: "+err);
 }
 let base=await launch();const call=async(route,body,operation)=>{const response=await fetch(base+"/internal/json-business/"+route,{method:body===undefined?"GET":"POST",headers:{...headers,...(operation?{"x-leafcode-business-operation":operation}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});return{http:response.status,body:await response.json()};};
 const before=readFileSync(join(data,"store.json")),mirror=await call("backend/tasks");assert.equal(mirror.body.status,200);assert.deepEqual(mirror.body.body.tasks.map(t=>[t.id,t.status]),[["code","archived"],["bot:b","idle"]]);assert.ok(!JSON.stringify(mirror).includes("PRIVATE"));assert.deepEqual(readFileSync(join(data,"store.json")),before);
 for(const url of["https://example.invalid/auth?token=PRIVATE","http://127.0.0.1/"]){const preview=await call("link-preview",{url});assert.equal(preview.body.status,200);assert.equal(preview.body.body.url,url);assert.equal(hostCalls,0);}
 assert.equal((await call("link-preview/image?id="+"a".repeat(32))).body.status,404);
 for(const route of ["projects/project/explorer","tasks/code/explorer"]){const metadata=await call(route);assert.equal(metadata.body.status,200);assert.equal(metadata.body.body.path,fixture);assert.equal(metadata.body.body.controlUrl,`http://127.0.0.1:${host.address().port}`);}
 assert.equal((await call("tasks/bot%3Ab/explorer")).body.status,403);
 const denied=await fetch(base+"/internal/json-business/backend/tasks",{headers:{...headers,"x-leafcode-business-authorized":"0"}});assert.equal(denied.status,403);
 const cross=await fetch(base+"/internal/json-business/link-preview",{method:"POST",headers:{...headers,origin:"https://evil.invalid"},body:'{"url":"https://example.invalid"}'});assert.equal((await cross.json()).status,403);
 const id="11111111-0123-4321-abcd-eeeeeeeeeeee",translated=await call("translation/reasoning",{texts:["Hello 日本語","second"],url:"http://evil.invalid",model:"forged"},id);assert.equal(translated.body.status,200);assert.deepEqual(translated.body.body.translations,["訳:Hello 日本語","訳:second"]);assert.deepEqual(translated.body.body.operation,{id,execution:"complete"});assert.equal(hostCalls,1);
 const ledgerPath=join(data,"reasoning-translation-command.json"),ledger=readFileSync(ledgerPath,"utf8");for(const secret of["日本語","Hello","second","PRIVATE","evil.invalid"])assert.ok(!ledger.includes(secret));if(process.platform!=="win32")assert.equal(statSync(ledgerPath).mode&0o777,0o600);
 assert.equal((await call("translation/reasoning",{texts:["repeat"]},id)).body.status,409);await stop();base=await launch();assert.equal((await call("translation/reasoning",{texts:["after restart"]},id)).body.status,409);assert.equal(hostCalls,1);assert.equal((await call("backend/tasks")).body.status,200);assert.equal((await call("link-preview/image?id="+"a".repeat(32))).body.status,404);assert.equal(existsSync(join(fixture,"web")),false);
});

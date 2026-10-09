import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createBackendServer, listenBackend, closeBackend } from "../../backend/src/server.mjs";
import { checkNextUiBoundary } from "../../scripts/check-next-ui-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url))), require = createRequire(join(ROOT, "web/package.json"));
async function port() { const s=createServer(); await new Promise(r=>s.listen(0,"127.0.0.1",r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
async function stop(c) { if (!c || c.exitCode!==null || c.signalCode!==null) return; const p=new Promise(r=>c.once("exit",r)); c.kill(); await p; }
test("actual UI/layout builds SDK-free and SSR settings stay Backend-owned across Web restart", { timeout: 180000 }, async t => {
  const base=mkdtempSync(join(tmpdir(),"leafcode-next-ui-")), app=join(base,"app"), children=[]; let backend;
  t.after(async()=>{for(const c of children)await stop(c);if(backend)await closeBackend(backend);rmSync(base,{recursive:true,force:true});});
  const gate=checkNextUiBoundary(ROOT); assert.ok(gate.roots>100);
  function copy(from,to) { mkdirSync(to,{recursive:true}); for(const e of readdirSync(from,{withFileTypes:true})) { if(e.name==="node_modules"||e.name===".next"||e.name.includes(".test."))continue; const a=join(from,e.name),b=join(to,e.name); if(e.isDirectory())copy(a,b);else copyFileSync(a,b); } }
  copy(join(ROOT,"web/src"),join(app,"source/web/src")); copy(join(ROOT,"shared"),join(app,"source/shared"));
  copy(join(ROOT,"web/public"),join(app,"public")); copy(join(ROOT,"web/src/app"),join(app,"app")); rmSync(join(app,"app/api"),{recursive:true,force:true});
  // Render a finite capability DTO through the real effort control; retain every real UI page/layout in the build.
  writeFileSync(join(app,"app/(app)/page.tsx"),'import {ThinkingSelect} from "@/components/ThinkingSelect"; export default function Page(){return <div><h1>fixture-model</h1><ThinkingSelect levels={["off","low","medium","xhigh"]} value="low" onChange={undefined as never}/></div>}');
  writeFileSync(join(app,"package.json"),JSON.stringify({name:"leafcode-ui-fixture",private:true}));
  writeFileSync(join(app,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",lib:["dom","esnext"],module:"esnext",moduleResolution:"bundler",jsx:"preserve",strict:true,esModuleInterop:true,skipLibCheck:true,baseUrl:".",paths:{"@/*":["source/web/src/*"],"@shared/*":["source/shared/*"]}},include:["app/**/*.tsx"]}));
  writeFileSync(join(app,"next.config.mjs"),'export default {typescript:{ignoreBuildErrors:true},experimental:{cpus:2,optimizePackageImports:["lucide-react"]}};');
  symlinkSync(join(ROOT,"web/node_modules"),join(app,"node_modules"),process.platform==="win32"?"junction":"dir");
  const token="fixture-internal-"+"x".repeat(32), webPort=await port(); let reads=0, model="fixture-model-before";
  backend=createBackendServer({token,isReady:()=>true,configurationRequestAction:async input=>{ assert.equal(input.route,"settings"); assert.equal(input.authorized,true); reads++;return Response.json({values:{"default-model":model,"model-effort":"low"}}); }});const addr=await listenBackend(backend,0);
  const env={...process.env,NODE_ENV:"production",NODE_OPTIONS:"",NEXT_TELEMETRY_DISABLED:"1",LEAFCODE_PI_PROCESS_ROLE:"next",LEAFCODE_PI_DATA_DIR:join(base,"unused-owner-data"),LEAFCODE_PI_BACKEND_URL:`http://127.0.0.1:${addr.port}`,LEAFCODE_PI_BACKEND_TOKEN:token,LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:"",LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:"fixture-browser"};
  const cli=require.resolve("next/dist/bin/next");function start(args){const c=spawn(process.execPath,[cli,...args],{cwd:app,env,stdio:["ignore","pipe","pipe"],windowsHide:true});children.push(c);let log="";for(const stream of[c.stdout,c.stderr])stream.on("data",b=>log=(log+b).slice(-16000));return{c,log:()=>log};}
  const build=start(["build","--webpack",app]);assert.equal(await new Promise(r=>build.c.once("exit",r)),0,build.log());
  async function web(){const run=start(["start","-p",String(webPort),"-H","127.0.0.1",app]);for(let i=0;i<150;i++){try{if((await fetch(`http://127.0.0.1:${webPort}/`,{signal:AbortSignal.timeout(1000)})).status===200)return run.c;}catch{}if(run.c.exitCode!==null)throw Error(run.log());await delay(50);}throw Error(run.log());}
  let c=await web();assert.equal(reads,0);const headers={cookie:"leafcode-pi-token=fixture-browser"};const first=await(await fetch(`http://127.0.0.1:${webPort}/`,{headers})).text();assert.ok(first.includes("fixture-model-before"), `private owner snapshot missing; owner reads=${reads}`);assert.match(first,/xhigh/);assert.ok(reads>0);assert.ok(!first.includes(token));assert.ok(!existsSync(join(base,"unused-owner-data")));
  await stop(c);const prior=reads;model="fixture-model-after";c=await web();assert.equal(reads,prior);const second=await(await fetch(`http://127.0.0.1:${webPort}/`,{headers})).text();assert.ok(second.includes("fixture-model-after"), `updated private owner snapshot missing; owner reads=${reads}`);assert.ok(!second.includes(token));await stop(c);
  t.diagnostic(`real UI build: ${gate.roots} roots/${gate.modules} runtime modules; anonymous SSR never reads settings; private owner snapshot updates across Web restart; no Next data directory`);
});

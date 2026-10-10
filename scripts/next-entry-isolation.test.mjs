import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { syncMirror } from "./web-build-mirror.mjs";
import { checkNextEntryBoundary, productionTypeConfig } from "./check-next-entry-boundary.mjs";
import { createBackendServer, listenBackend, closeBackend } from "../backend/src/server.mjs";
const ROOT=resolve(fileURLToPath(new URL("../",import.meta.url)));
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(c){if(!c||c.exitCode!==null||c.signalCode!==null)return;const done=new Promise(r=>c.once("exit",r));c.kill();await done;}
test("full production Next builds and typechecks without owner source or SDK/native packages",{timeout:240000},async t=>{
  const root=mkdtempSync(join(tmpdir(),"leafcode-next-all-entry-")),mirror=join(root,"mirror"),children=[];let backend;
  t.after(async()=>{for(const c of children)await stop(c);if(backend)await closeBackend(backend);rmSync(root,{recursive:true,force:true});});
  const boundary=checkNextEntryBoundary(ROOT),result=syncMirror({sourceDir:join(ROOT,"web"),mirrorRoot:mirror});
  assert.equal(result.mirrorRoot,mirror);assert.equal(existsSync(join(mirror,"backend")),false);assert.equal(existsSync(join(mirror,"extensions")),false);
  const manifest=JSON.parse(readFileSync(join(mirror,"package.json"),"utf8")),lock=JSON.parse(readFileSync(join(mirror,"package-lock.json"),"utf8"));
  assert.deepEqual(lock.packages[""].dependencies,manifest.dependencies);
  for(const name of Object.keys(lock.packages))assert.doesNotMatch(name,/@earendil-works\/(?:pi-|photon)|@rahularya01\/pi-cursor|node_modules\/(?:better-sqlite3|pi-commandcode-provider)(?:\/|$)/);
  writeFileSync(join(mirror,"tsconfig.production.json"),JSON.stringify(productionTypeConfig(boundary.entries)));
  // Use an actual clean manifest/lock install when provided; never the Backend SDK installation.
  const installed=process.env.LEAFCODE_PI_NEXT_DEPENDENCY_DIR || join(ROOT,"web/node_modules"),names=["next","react","react-dom","lucide-react","next-themes","react-markdown","remark-gfm","undici","typescript","tailwindcss","@tailwindcss/postcss","@types/node","@types/react","@types/react-dom","@types/mdast","@types/unist"];
  for(const name of names){const from=join(installed,name);if(!existsSync(from))continue;const dest=join(mirror,"node_modules",name);mkdirSync(dirname(dest),{recursive:true});symlinkSync(from,dest,process.platform==="win32"?"junction":"dir");}
  for(const name of ["@earendil-works/pi-coding-agent","@earendil-works/pi-ai","@rahularya01/pi-cursor","pi-commandcode-provider","better-sqlite3","jiti"]){assert.equal(existsSync(join(mirror,"node_modules",name)),false);}
  const nextConfig=readFileSync(join(mirror,"next.config.ts"),"utf8").replace("  experimental: {","  experimental: {\n    cpus: 2,");writeFileSync(join(mirror,"next.config.ts"),nextConfig);
  const env={...process.env,NODE_ENV:"production",NODE_OPTIONS:"",NEXT_TELEMETRY_DISABLED:"1",LEAFCODE_PI_PROCESS_ROLE:"next",LEAFCODE_PI_DATA_DIR:join(root,"no-next-owner-data"),LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:"",LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_WEBUI_TOKEN:"finite-browser",LEAFCODE_PI_BACKEND_TOKEN:"finite-internal-"+"x".repeat(32),LEAFCODE_PI_PUSHOVER_TOKEN:"",LEAFCODE_PI_PUSHOVER_USER:""};
  function launch(args){const c=spawn(process.execPath,args,{cwd:mirror,env,stdio:["ignore","pipe","pipe"],windowsHide:true});children.push(c);let output="";for(const s of[c.stdout,c.stderr])s.on("data",b=>output=(output+b).slice(-50000));return{c,log:()=>output};}
  const types=launch([join(mirror,"node_modules/typescript/bin/tsc"),"--noEmit","-p","tsconfig.production.json"]);assert.equal(await new Promise(r=>types.c.once("exit",r)),0,types.log());
  const cli=createRequire(join(installed,"../package.json")).resolve("next/dist/bin/next"),build=launch([cli,"build","--webpack",mirror]);assert.equal(await new Promise(r=>build.c.once("exit",r)),0,build.log());
  const generatedTypes=launch([join(mirror,"node_modules/typescript/bin/tsc"),"--noEmit","-p","tsconfig.production.json"]);assert.equal(await new Promise(r=>generatedTypes.c.once("exit",r)),0,generatedTypes.log());
  // Trace manifests are production evidence, not just an import-source assertion.
  let traces=0;function inspect(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())inspect(p);else if(e.name.endsWith(".nft.json")){traces++;for(const dependency of JSON.parse(readFileSync(p,"utf8")).files){const path=dependency.replaceAll("\\","/");assert.doesNotMatch(path,/node_modules\/(?:@earendil-works\/pi-|@rahularya01\/pi-cursor|pi-commandcode-provider|better-sqlite3|jiti)(?:\/|$)|backend\/runtime-src|backend\/core|extensions\/leafcode-/);}}}}
  inspect(join(mirror,".next"));assert.ok(traces>=boundary.routes);
  backend=createBackendServer({token:env.LEAFCODE_PI_BACKEND_TOKEN,isReady:()=>true,configurationRequestAction:async()=>Response.json({values:{"default-model":"finite-owner-model"}})});const addr=await listenBackend(backend,0);env.LEAFCODE_PI_BACKEND_URL=`http://127.0.0.1:${addr.port}`;const port=await freePort(),base=`http://127.0.0.1:${port}`,headers={cookie:"leafcode-pi-token=finite-browser"};
  async function web(){const run=launch([cli,"start","-p",String(port),"-H","127.0.0.1",mirror]);for(let i=0;i<200;i++){try{if((await fetch(base+"/api/health",{signal:AbortSignal.timeout(1000)})).status===200)return run.c;}catch{}if(run.c.exitCode!==null)throw Error(run.log());await delay(50);}throw Error(run.log());}
  let c=await web();assert.equal((await fetch(base+"/api/backend/status")).status,401);const status=await(await fetch(base+"/api/backend/status",{headers})).json();assert.equal(status.ownsRuntime,false);assert.equal(status.backend.ready,true);assert.ok(!JSON.stringify(status).includes(env.LEAFCODE_PI_BACKEND_TOKEN));
  const page=await(await fetch(base+"/",{headers})).text();assert.ok(page.includes("finite-owner-model"));assert.ok(!page.includes(env.LEAFCODE_PI_BACKEND_TOKEN));assert.equal(existsSync(env.LEAFCODE_PI_DATA_DIR),false);
  await stop(c);assert.equal((await fetch(env.LEAFCODE_PI_BACKEND_URL+"/internal/health",{headers:{authorization:`Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`,"x-leafcode-backend-protocol":"1"}})).status,200);c=await web();assert.equal((await(await fetch(base+"/api/backend/status",{headers})).json()).backend.ready,true);
  await closeBackend(backend);backend=null;const unavailable=await(await fetch(base+"/api/backend/status",{headers})).json();assert.equal(unavailable.backend.reachable,false);assert.equal(existsSync(env.LEAFCODE_PI_DATA_DIR),false);await stop(c);
  t.diagnostic(`full mirror: ${boundary.roots} roots/${boundary.routes} routes/${boundary.modules} runtime/${boundary.typeModules} type modules; ${traces} traces free of owner/SDK/native packages; production types before/after build; auth and owner snapshot; no Next data`);
});

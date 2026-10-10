import assert from "node:assert/strict";
import { createServer as createViteServer } from "../../web/node_modules/vite/dist/node/index.js";
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { createConnection, createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDevelopmentGateway } from "./development.mjs";
async function port() { const s=createServer(); await new Promise(r=>s.listen(0,"127.0.0.1",r));const p=s.address().port;await new Promise(r=>s.close(r));return p; }
async function ws(base,path,{origin=base,cookie="",protocol="vite-hmr"}={}) {
 const url=new URL(base), socket=createConnection({host:url.hostname,port:Number(url.port)}); let bytes=Buffer.alloc(0);
 await new Promise((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
 socket.write("GET "+path+" HTTP/1.1\r\nHost: "+url.host+"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZGV2ZWxvcG1lbnQtZml4dA==\r\nSec-WebSocket-Protocol: "+protocol+"\r\n"+(origin?"Origin: "+origin+"\r\n":"")+(cookie?"Cookie: "+cookie+"\r\n":"")+"\r\n");
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(Error("upgrade deadline"));},3000);socket.on("data",chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.includes(Buffer.from("\r\n\r\n"))){clearTimeout(timer);socket.destroy();resolve(Number(bytes.toString().match(/^HTTP\/1\.1 (\d+)/)?.[1]));}});socket.once("error",e=>{clearTimeout(timer);reject(e);});});
}
test("real Vite middleware/HMR has one controlled listener, pinned public Login, exclusive API and authenticated same-Origin sources", {timeout:60000}, async t=>{
 const root=mkdtempSync(join(tmpdir(),"p3-dev-")),webRoot=join(root,"web"),staticRoot=join(root,"sealed/spa");
 for(const folder of ["web/src","shared","sealed/spa/assets","private"])mkdirSync(join(root,folder),{recursive:true});
 const source=label=>'document.querySelector("#app").textContent="'+label+'";window.__birth ||= Date.now();if(import.meta.hot)import.meta.hot.accept();';
 writeFileSync(join(webRoot,"index.html"),'<html><div id="app"></div><script type="module" src="/src/main.ts"></script></html>');
 writeFileSync(join(webRoot,"src/main.ts"),source("version-one"));
 writeFileSync(join(staticRoot,"index.html"),'<html><h1>sealed login</h1><script type="module" src="/assets/index-Abc123_-.js"></script></html>');
 writeFileSync(join(staticRoot,"assets/index-Abc123_-.js"),"export {};");
 writeFileSync(join(webRoot,".env"),"DUMMY_PRIVATE=fixture-only");writeFileSync(join(root,"private/file.ts"),"export const secret='fixture';");
 symlinkSync(join(root,"private"),join(webRoot,"src/link"),process.platform==="win32"?"junction":"dir");
 const old={...process.env};process.env.LEAFCODE_PI_WEBUI_AUTH="required";process.env.LEAFCODE_PI_WEBUI_TOKEN="finite-dev-token";
 const listeningPort=await port(),base="http://127.0.0.1:"+listeningPort,cookie="leafcode-pi-token=finite-dev-token",headers={cookie};
 let dev,browser;
 t.after(async()=>{await browser?.close();await dev?.close();for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);rmSync(root,{recursive:true,force:true});});
 console.log("dev-check: initializing");
 dev=await createDevelopmentGateway([{route:"/api/fixture",methods:["GET","POST"],load:async()=>({GET:()=>Response.json({error:"Backend unavailable"},{status:503}),POST:()=>Response.json({error:"Backend unavailable"},{status:503})})}],{createViteServer,webRoot,staticRoot,hostname:"127.0.0.1",port:listeningPort,configFile:false,dependencyRoot:resolve("web/node_modules"),scratchRoot:root,logLevel:"silent"});
 await new Promise(r=>dev.server.listen(listeningPort,"127.0.0.1",r));
 console.log("dev-check: listening");
 assert.equal(dev.privateHmr.listening,false);assert.equal(dev.vite.httpServer,null);
 const login=await fetch(base+"/login");assert.equal(login.status,200);assert.ok((await login.text()).includes("sealed login"));
 for(const path of ["/@vite/client","/src/main.ts","/@fs/"+join(root,"private/file.ts").replaceAll("\\","/")])assert.equal((await fetch(base+path,{redirect:"manual"})).status,401);
 assert.equal((await fetch(base+"/settings",{redirect:"manual"})).status,307);
 const clientResponse=await fetch(base+"/@vite/client",{headers});assert.equal(clientResponse.headers.get("cache-control"),"private, no-store");const client=await clientResponse.text();assert.ok(client.includes("vite"));const token=client.match(/const wsToken = ["']([^"']+)/)?.[1];assert.ok(token,"Vite WS nonce");
 assert.equal((await fetch(base+"/src/main.ts",{headers})).status,200);
 for(const path of ["/src/main.ts?raw","/.env","/@fs/"+join(root,"private/file.ts").replaceAll("\\","/"),"/src/link/file.ts"]) {const r=await fetch(base+path,{headers});assert.notEqual(r.status,200,path);assert.ok(!(await r.text()).includes("fixture-only"));}
 assert.equal((await fetch(base+"/@vite/client",{headers:{...headers,origin:"https://evil.invalid"}})).status,403);
 assert.equal((await fetch(base+"/src/main.ts",{headers:{...headers,"sec-fetch-site":"cross-site"}})).status,403);
 assert.equal((await fetch(base+"/api/fixture",{headers:{...headers,host:"rebinding.invalid:"+listeningPort,origin:"http://rebinding.invalid:"+listeningPort}})).status,403);
 for(const path of ["/api/unknown","/assets/missing.js","/unknown-screen"]) {const r=await fetch(base+path,{headers});assert.equal(r.status,404);assert.ok(!(await r.text()).includes("<html"));}
 const unavailable=await fetch(base+"/api/fixture",{headers});assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes("<html"));
 console.log("dev-check: HTTP passed");
 const hmr="/__vite_hmr?token="+encodeURIComponent(token);
 assert.equal(await ws(base,hmr),401);assert.equal(await ws(base,hmr,{cookie,origin:"https://evil.invalid"}),403);assert.equal(await ws(base,hmr,{cookie,origin:""}),403);
 assert.equal(await ws(base,"/wrong?token="+token,{cookie}),403);assert.equal(await ws(base,hmr,{cookie,protocol:"other"}),403);assert.equal(await ws(base,hmr,{cookie}),101);
 console.log("dev-check: upgrades passed");
 browser=await chromium.launch({headless:true,...(process.env.LEAFCODE_TEST_CHROMIUM?{executablePath:process.env.LEAFCODE_TEST_CHROMIUM}:{})});
 const context=await browser.newContext();await context.addCookies([{name:"leafcode-pi-token",value:"finite-dev-token",url:base}]);
 const page=await context.newPage(),errors=[],sockets=[];page.on("pageerror",e=>errors.push(e.message));page.on("websocket",s=>sockets.push(s.url()));
 page.on("requestfailed",r=>console.log("dev-check: failed",new URL(r.url()).pathname,r.failure()?.errorText));
 await page.goto(base+"/settings");console.log("dev-check: body",await page.locator("body").innerText(),errors);await page.getByText("version-one",{exact:true}).waitFor({timeout:10000});const birth=await page.evaluate(()=>window.__birth);
 console.log("dev-check: browser mounted");
 writeFileSync(join(webRoot,"src/main.ts"),source("version-two"));await page.getByText("version-two",{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__birth),birth);assert.deepEqual(errors,[]);assert.ok(sockets.length);assert.ok(sockets.every(url=>new URL(url).host===new URL(base).host));
 t.diagnostic(JSON.stringify({httpOrigin:base,privateListener:false,viteHttpServer:null,hmrSameOrigin:true,hotUpdateWithoutReload:true,websocketCases:6}));
});

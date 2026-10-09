import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import * as store from "@backend-runtime/lib/store";
import { getLinkPreview, getLinkPreviewImage } from "@backend-runtime/lib/link-preview";
import { fetchPublicWebBytes } from "@backend-runtime/lib/public-web-fetch";
import { translateReasoningAtHost } from "@backend-runtime/lib/reasoning-translation-owner";
let root: string;
beforeEach(() => {
  root=mkdtempSync(join(tmpdir(),"leafcode-service-owner-"));
  for(const [key,value]of Object.entries({LEAFCODE_PI_PROCESS_ROLE:"backend",LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_DATA_DIR:root,PI_CODING_AGENT_DIR:join(root,"agent"),LEAFCODE_PI_HOST_CONTROL_URL:"http://127.0.0.1:32199"}))vi.stubEnv(key,value);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const request=(route="translation/reasoning",body:unknown={texts:["Hello"]},extra:Record<string,any>={})=>dispatchJsonBusinessRequest({route,method:route==="backend/tasks"||route==="link-preview/image"?"GET":"POST",url:"http://localhost/api/"+route,headers:{"content-type":"application/json"},authorized:true,operationId:route==="translation/reasoning"?randomUUID():undefined,...(route==="translation/reasoning"||route==="link-preview"?{body:new TextEncoder().encode(JSON.stringify(body))}:{}),...extra});
it("development Next refuses dispatch/cache/public transport/Host before any IO",async()=>{
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const read=vi.spyOn(store,"listTasks");
  for(const work of[()=>request(),()=>request("backend/tasks"),()=>getLinkPreview("https://example.com"),()=>getLinkPreviewImage("a".repeat(32)),()=>fetchPublicWebBytes("https://example.com",{maxBytes:8,accept:"text/html"}),()=>translateReasoningAtHost(["x"])])await expect(work()).rejects.toThrow(/owned by Backend/);
  expect(fetch).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
});
it("stored task mirror includes archived and Bot rows without SDK hydration or caller-selected filters",async()=>{
  const read=vi.spyOn(store,"listTasks").mockImplementation((_archived,kind)=>kind==="bot"?[{id:"bot:b",status:"idle",kind:"bot",token:"PRIVATE"}]:[{id:"t",status:"archived",metadata:{token:"PRIVATE"}}] as any);
  const result=await request("backend/tasks",null,{url:"http://localhost/api/backend/tasks?kind=code&archived=false"});
  expect(result.body).toEqual({source:"backend",tasks:[{id:"t",status:"archived"},{id:"bot:b",status:"idle",kind:"bot"}]});
  expect(read.mock.calls).toEqual([[true],[true,"bot"]]);expect(readdirSync(root)).toEqual([]);
});
it("authorization, Origin and bounds precede reads/inference; readonly previews do not create receipts",async()=>{
  const read=vi.spyOn(store,"listTasks");const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  expect((await request("backend/tasks",null,{authorized:false})).status).toBe(401);
  expect((await request("link-preview",{url:"https://example.com"},{headers:{origin:"https://evil.invalid"}})).status).toBe(403);
  expect((await request("link-preview",{}, {body:new Uint8Array(32769)})).status).toBe(413);
  expect((await request("link-preview",{url:"https://example.com/auth?token=PRIVATE"})).body).toEqual({url:"https://example.com/auth?token=PRIVATE",title:"example.com",siteName:"example.com"});
  expect(read).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
});
it("fixed stored Host destination consumes only texts; receipt replay and persisted ledger exclude content",async()=>{
  const fetch=vi.fn(async()=>Response.json({translations:["日本語"],fallbacks:[false],overridden:[true],token:"PRIVATE",operation:{id:randomUUID(),execution:"complete"}}));vi.stubGlobal("fetch",fetch);
  const id=randomUUID(),result=await request(undefined,{texts:[" Hello "],url:"http://evil/",model:"forged",token:"PRIVATE"},{operationId:id});
  expect(result.body).toEqual({translations:["日本語"],fallbacks:[false],overridden:[true],operation:{id,execution:"complete"}});
  const [url,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];expect(String(url)).toBe("http://127.0.0.1:32199/translation/translate");
  expect(options).toMatchObject({redirect:"error",cache:"no-store"});expect(JSON.parse(String(options.body))).toEqual({texts:[" Hello "]});expect(options.headers).toEqual({"Content-Type":"application/json"});
  expect((await request(undefined,{texts:["different"]},{operationId:id})).status).toBe(409);expect(fetch).toHaveBeenCalledOnce();
  const ledger=readFileSync(join(root,"reasoning-translation-command.json"),"utf8");for(const secret of["Hello","日本語","32199","PRIVATE"])expect(ledger).not.toContain(secret);
});
it.each([null,{}, {texts:[]},{texts:[""]},{texts:[1]},{texts:Array(17).fill("x")},{texts:["x".repeat(16001)]}])("invalid translation input never reaches Host: %j",async body=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);expect((await request(undefined,body)).status).toBe(400);expect(fetch).not.toHaveBeenCalled();
});
it.each([
  ()=>Response.json({translations:["one","extra"]}),
  ()=>Response.json({translations:["x"],fallbacks:[0]}),
  ()=>new Response("PRIVATE",{status:400}),
  ()=>new Response("x".repeat(256*1024+1)),
  ()=>new Response(new Uint8Array([0xff])),
  ()=>new Response("PRIVATE",{status:503}),
])("invalid/post-start Host responses retain unknown and suppress raw failures",async reply=>{
  const fetch=vi.fn(async()=>reply());vi.stubGlobal("fetch",fetch);const id=randomUUID();const result=await request(undefined,undefined,{operationId:id});
  expect(result.status).toBe(503);expect(result.body?.operation).toEqual({id,execution:"unknown"});expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect((await request(undefined,undefined,{operationId:id})).status).toBe(409);expect(fetch).toHaveBeenCalledOnce();
});
it("accepted Host inference continues after disconnect without serializing other commands",async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  vi.stubGlobal("fetch",vi.fn(async(_url,options)=>{expect(options.signal.aborted).toBe(false);entered();await gate;return Response.json({translations:["日本語"]});}));
  const controller=new AbortController(),pending=request(undefined,undefined,{signal:controller.signal});await started;controller.abort();
  expect((await request(undefined,{})).status).toBe(400);release();expect((await pending).status).toBe(200);
});
it("unsafe control URL cannot smuggle credentials, path or query to Host",async()=>{
  for(const url of["http://user:PRIVATE@127.0.0.1:32199","http://127.0.0.1:32199/private","http://127.0.0.1:32199/?token=PRIVATE"]){
    vi.stubEnv("LEAFCODE_PI_HOST_CONTROL_URL",url);const fetch=vi.fn();vi.stubGlobal("fetch",fetch);expect((await request()).status).toBe(503);expect(fetch).not.toHaveBeenCalled();
  }
});

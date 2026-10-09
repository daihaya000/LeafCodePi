import { randomUUID } from "node:crypto";
import { mkdtempSync,readdirSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import * as bots from "@/lib/bots";
import * as routines from "@/lib/routines";
import * as harness from "@/lib/pi/harness";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
const botId="11111111-0123-4321-abcd-eeeeeeeeeeee",other="22222222-0123-4321-abcd-eeeeeeeeeeee";
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-bot-routine-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));vi.spyOn(routines,"ensureRoutineScheduler").mockImplementation(()=>{});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const config=()=>({name:" auth 日本語 ",prompt:" authored 日本語 ",schedule:"0 0 29 2 *",enabled:true});
const exists=()=>vi.spyOn(bots,"getBot").mockImplementation(id=>({id,name:"Fixture",enabled:true,permissionMode:"ask"} as never));
async function request(suffix="",method="GET",body?:unknown,id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal,selector=botId){const path=`bots/${selector}/routines${suffix}`,result=await dispatchJsonBusinessRequest({route:path,method,url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:method==="GET"?undefined:id,signal,body:body===undefined?undefined:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))});const dto=publicJsonBusinessResult(path,result,method);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};}
async function create(){exists();const response=await request("","POST",config());expect(response.status).toBe(201);return response.body.routine as Record<string,unknown>&{id:string};}
describe("Bot routine Backend owner",()=>{
 it("persists owner-scoped authored config, selects create fields, projects reads and refuses duplicate mutation IDs",async()=>{
  exists();const id=randomUUID(),created=await request("","POST",{...config(),botId:other,id:other,failureCount:99,lastRunAt:"FORGED",permissionMode:"allow"},id);expect(created.status).toBe(201);const routine=created.body.routine as {id:string};expect(created.body.routine).toMatchObject({botId,name:"auth 日本語",prompt:"authored 日本語",failureCount:0,lastRunAt:null});expect(routine.id).not.toBe(other);expect((await request("","POST",{},id)).status).toBe(409);
  expect((await request()).body.routines).toEqual([created.body.routine]);expect((await request("/"+routine.id)).body.routine).toEqual(created.body.routine);expect((await request("/"+routine.id,"PATCH",{name:" updated ",enabled:false})).body.routine).toMatchObject({name:"updated",enabled:false});expect((await request("/"+routine.id,"PATCH",{enabled:true},undefined,true,undefined,undefined,other)).status).toBe(404);
  const file=JSON.parse(readFileSync(join(root,"bots",botId,"routines",routine.id+".json"),"utf8"));expect(file.name).toBe("updated");expect((await request("/"+routine.id,"DELETE")).body.ok).toBe(true);expect((await request("/"+routine.id)).status).toBe(404);
  const ledger=readFileSync(join(root,"bot-routine-command.json"),"utf8");for(const value of [botId,routine.id,"authored","FORGED"])expect(ledger).not.toContain(value);
 });
 it("calendar/name/prompt limits and PATCH fields are real owner validation; escaped maximum fits its budget",async()=>{
  const routine=await create();for(const patch of [true,2,[],{prompt:"x".repeat(8001)},{name:"x".repeat(101)},{schedule:"* * * * *"},{schedule:"0 0 30 2 *"},{enabled:"true"},{failureCount:1}])expect((await request("/"+routine.id,"PATCH",patch)).status).toBe(400);
  const max=await request("/"+routine.id,"PATCH",{prompt:"\u0000".repeat(8000),name:"😀".repeat(100),schedule:"0 0 29 2 *"});expect(max.status).toBe(200);expect((max.body.routine as {prompt:string}).prompt.length).toBe(8000);
 });
 it("manual run uses stored prompt/permission, waits for generation, exposes successful timestamps and never caller authority",async()=>{
  const routine=await create(),prompt=vi.spyOn(harness,"promptTask").mockResolvedValue({} as never);vi.spyOn(harness,"getTaskDetail").mockResolvedValue({status:"idle",messages:[{role:"assistant",parts:[{type:"text",text:"response 日本語"}]}]} as never);
  const id=randomUUID(),result=await request("/"+routine.id+"/run","POST",{taskId:"FORGED",prompt:"FORGED",permissionMode:"allow"},id);expect(result.status).toBe(200);expect(result.body.routine).toMatchObject({failureCount:0});expect((result.body.routine as {lastRunAt:unknown}).lastRunAt).toEqual(expect.any(String));expect(prompt).toHaveBeenCalledExactlyOnceWith("bot:"+botId,"[ルーティン: auth 日本語]\nauthored 日本語",undefined,{waitForCompletion:true,permissionMode:"ask"});expect((await request("/"+routine.id+"/run","POST",{},id)).status).toBe(409);expect(prompt).toHaveBeenCalledOnce();
 });
 it("disable is concurrent with a held run, client disconnect does not abort admission, and failure snapshot preserves disable",async()=>{
  const routine=await create();let fail!:(error:Error)=>void;const prompt=vi.spyOn(harness,"promptTask").mockImplementation(()=>new Promise((_resolve,reject)=>{fail=reject;})),controller=new AbortController(),id=randomUUID();
  const held=request("/"+routine.id+"/run","POST",{},id,true,undefined,controller.signal);await vi.waitFor(()=>expect(prompt).toHaveBeenCalledOnce());expect((await request("/"+routine.id,"PATCH",{enabled:false})).status).toBe(200);controller.abort();fail(new Error("PRIVATE SDK/path"));const failed=await held;expect(failed.status).toBe(500);expect(failed.body).toMatchObject({routine:{enabled:false,failureCount:1,lastRunAt:null},operation:{execution:"unknown"}});expect(JSON.stringify(failed.body)).not.toContain("PRIVATE");expect((await request("/"+routine.id+"/run","POST",{},id)).status).toBe(409);expect(prompt).toHaveBeenCalledOnce();
 });
 it("busy lease is a known refusal without consuming run timestamp/failure count; deleted in-flight routine is not recreated",async()=>{
  const routine=await create(),prompt=vi.spyOn(harness,"promptTask").mockRejectedValueOnce(Object.assign(new Error("タスクは別のワーカーで実行中です"),{status:409}));const refusal=await request("/"+routine.id+"/run","POST",{});expect(refusal.status).toBe(409);expect(refusal.body).toMatchObject({routine:{failureCount:0,lastRunAt:null},operation:{execution:"complete"}});
  let fail!:(error:Error)=>void;prompt.mockImplementation(()=>new Promise((_resolve,reject)=>{fail=reject;}));const held=request("/"+routine.id+"/run","POST",{});await vi.waitFor(()=>expect(prompt).toHaveBeenCalledTimes(2));expect((await request("/"+routine.id,"DELETE")).status).toBe(200);fail(new Error("PRIVATE"));expect((await held).status).toBe(500);expect((await request("/"+routine.id)).status).toBe(404);expect(routines.listRoutines(botId)).toEqual([]);
 });
 it("malformed owner success/read and unexpected IO errors become sanitized failures, not empty lists or validation errors",async()=>{
  exists();vi.spyOn(routines,"listRoutines").mockReturnValue([{}] as never);expect((await request()).status).toBe(503);const create=vi.spyOn(routines,"createRoutine").mockImplementation(()=>{throw new Error("PRIVATE filesystem after-save");}),id=randomUUID();const result=await request("","POST",config(),id);expect(result.status).toBe(500);expect(result.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect((await request("","POST",config(),id)).status).toBe(409);expect(create).toHaveBeenCalledOnce();
 });
 it("auth/Origin/bounds/decode-once IDs and every routine/scheduler entry guard before read/cache/FS/SDK",async()=>{
  const bot=vi.spyOn(bots,"getBot"),prompt=vi.spyOn(harness,"promptTask"),before=readdirSync(root);expect((await request("","POST",{},undefined,false)).status).toBe(401);expect((await request("","POST",{},undefined,true,"https://evil.test")).status).toBe(403);expect((await request("","POST","x".repeat(65537))).status).toBe(413);expect(readdirSync(root)).toEqual(before);
  for(const selector of ["invalid","..%2Fx","%252F"])expect((await request("","GET",undefined,undefined,true,undefined,undefined,selector)).status).toBe(400);for(const suffix of ["/%252F","/..%2Fx/run"])expect((await request(suffix,suffix.endsWith("/run")?"POST":"GET",suffix.endsWith("/run")?{}:undefined)).status).toBe(400);expect(bot).not.toHaveBeenCalled();
  vi.mocked(routines.ensureRoutineScheduler).mockRestore();vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");for(const fn of [()=>routines.listRoutines(botId),()=>routines.getRoutine(botId,other),()=>routines.createRoutine(botId,config()),()=>routines.patchRoutine(botId,other,{}),()=>routines.deleteRoutine(botId,other),()=>routines.ensureRoutineScheduler()])expect(fn).toThrow("owned by Backend");await expect(routines.runRoutine(botId,other)).rejects.toThrow("owned by Backend");await expect(routines.tickRoutines()).rejects.toThrow("owned by Backend");await expect(request()).rejects.toThrow("owned by Backend");expect(bot).not.toHaveBeenCalled();expect(prompt).not.toHaveBeenCalled();
 });
});

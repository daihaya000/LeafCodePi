import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as harness from "@/lib/pi/harness";
import * as store from "@/lib/store";
import * as runs from "@/lib/pi/subagent-runs";
import * as entrances from "@backend-runtime/lib/task-supervision";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-supervisor-owner-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const task=(supervisorBotId:string|null="one")=>({id:"t",status:"working",supervisorBotId,sessionFile:"OWNER-SESSION",directory:"OWNER-CWD",token:"PRIVATE"} as never);
async function request(action="supervisor",body:unknown={botId:"one"},id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal,taskId="t",query=""){
 const path=`tasks/${taskId}/${action}`,method=action==="subagents"?"GET":"POST",result=await dispatchJsonBusinessRequest({route:path,method,url:`http://localhost/api/${path}${query}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:method==="GET"?undefined:id,signal,...(method==="GET"?{}:{body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))})});
 const dto=publicJsonBusinessResult(path,result,method);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};
}
describe("Task supervision Backend owner",()=>{
 it("handoff/release use only authored Bot selector, scrub summary and persist ID-only replay receipts",async()=>{
  const handoff=vi.spyOn(harness,"handoffTaskToBot").mockResolvedValue(task()),release=vi.spyOn(harness,"releaseTaskFromBot").mockResolvedValue(task(null)),id=randomUUID();
  const adopted=await request("supervisor",{botId:" one ",approved:true,fromBot:true,codeTaskId:"forged"},id);expect(adopted.status).toBe(200);expect(adopted.body).toMatchObject({task:{supervisorBotId:"one"},operation:{id,execution:"complete"}});expect(JSON.stringify(adopted.body)).not.toContain("PRIVATE");expect(handoff).toHaveBeenCalledExactlyOnceWith("one","t");
  expect((await request("supervisor",{},id)).status).toBe(409);expect(handoff).toHaveBeenCalledOnce();
  expect((await request("supervisor",{botId:null,action:"abort"})).body).toMatchObject({task:{supervisorBotId:null}});expect(release).toHaveBeenCalledExactlyOnceWith("t");
  const ledger=readFileSync(join(root,"task-supervision-command.json"),"utf8");for(const text of ["one","forged","OWNER","PRIVATE"])expect(ledger).not.toContain(text);
 });
 it("release is not queued behind a deferred notice; admitted disconnect cannot undo an outbox write",async()=>{
  let finish!:(value:never)=>void;const handoff=vi.spyOn(harness,"handoffTaskToBot").mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),release=vi.spyOn(harness,"releaseTaskFromBot").mockResolvedValue(task(null)),controller=new AbortController(),id=randomUUID();
  const held=request("supervisor",{botId:"one"},id,true,undefined,controller.signal);await vi.waitFor(()=>expect(handoff).toHaveBeenCalledOnce());
  expect((await request("supervisor",{botId:null})).status).toBe(200);expect(release).toHaveBeenCalledOnce();controller.abort();finish(task());expect((await held).status).toBe(200);expect((await request("supervisor",{},id)).status).toBe(409);
 });
 it("refusals/partial provider failures/malformed SDK success never invent task ownership or replay effects",async()=>{
  const handoff=vi.spyOn(harness,"handoffTaskToBot");
  for(const status of [403,404,409,500]){handoff.mockRejectedValueOnce(Object.assign(new Error("PRIVATE refusal"),{status}));const id=randomUUID(),result=await request("supervisor",{botId:"one"},id);expect(result.status).toBe(status);expect(result.body).toMatchObject({operation:{execution:status<500?"complete":"unknown"}});if(status>=500)expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect((await request("supervisor",{},id)).status).toBe(409);}
  handoff.mockResolvedValueOnce({id:"t"} as never);const result=await request();expect(result.status).toBe(503);expect(result.body).toMatchObject({operation:{execution:"unknown"}});
 });
 it("subagent reads use only the owner's registered paths and numeric since; no admission ledger or hydration",async()=>{
  const get=vi.spyOn(store,"getTask").mockReturnValue(task()),list=vi.spyOn(runs,"listSubagentRuns").mockReturnValue([]),before=readdirSync(root),ensure=vi.spyOn(harness,"getTaskDetail");
  for(const [query,since] of [["?since=123&cwd=FORGED&sessionFile=FORGED",123],["?since=bad",undefined],["?since=Infinity",undefined],["",undefined]] as const){
   expect((await request("subagents",{},randomUUID(),true,undefined,undefined,"t",query)).body).toEqual({runs:[]});expect(list.mock.calls.at(-1)).toEqual([{sessionFile:"OWNER-SESSION",cwd:"OWNER-CWD",...(since===undefined?{}:{sinceMs:since})}]);
  }
  expect(readdirSync(root)).toEqual(before);expect(ensure).not.toHaveBeenCalled();get.mockReturnValueOnce(undefined);expect((await request("subagents")).status).toBe(404);
  list.mockReturnValueOnce([{}] as never);expect((await request("subagents")).status).toBe(503);
 });
 it("auth/Origin/bounds/ID and Next entrances refuse before SDK, metadata, artifacts or durable admission",async()=>{
  const handoff=vi.spyOn(harness,"handoffTaskToBot"),release=vi.spyOn(harness,"releaseTaskFromBot"),get=vi.spyOn(store,"getTask"),list=vi.spyOn(runs,"listSubagentRuns"),before=readdirSync(root);
  for(const action of ["supervisor","subagents"])expect((await request(action,{},randomUUID(),false)).status).toBe(401);
  expect((await request("supervisor",{},randomUUID(),true,"https://evil.test")).status).toBe(403);expect((await request("supervisor","x".repeat(4097))).status).toBe(413);expect(readdirSync(root)).toEqual(before);
  for(const taskId of ["..%2Fx","%252F"])for(const action of ["supervisor","subagents"])expect((await request(action,{},randomUUID(),true,undefined,undefined,taskId)).status).toBe(400);
  for(const body of [null,[],{},2,{botId:2},{botId:" "},{botId:"../escape"},{botId:"x".repeat(129)}])expect((await request("supervisor",body)).status).toBe(400);
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");for(const fn of [()=>entrances.handoffTaskToBot("one","t"),()=>entrances.releaseTaskFromBot("t"),()=>entrances.readTaskSubagentRuns("t")])expect(fn).toThrow("owned by Backend");
  await expect(request()).rejects.toThrow("owned by Backend");for(const spy of [handoff,release,get,list])expect(spy).not.toHaveBeenCalled();
 });
});

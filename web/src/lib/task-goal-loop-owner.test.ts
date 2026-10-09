import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { insertTask, patchTask, getTask } from "@/lib/store";
import * as harness from "@/lib/pi/harness";
import * as relay from "@/lib/pi/bot-code-relay";
import * as entrances from "@backend-runtime/lib/task-goal-loop";
import { startGoalLoopWithSelection } from "@/lib/pi/goal-loop-start";
import { invalidateTaskPreparations } from "@backend-runtime/lib/pi/task-operation-guard";
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-goal-owner-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
function task(){const row=insertTask({project:null,title:"Goal owner",providerID:"old",modelID:"old"});return patchTask(row.id,{directory:root,sessionId:"fixture-goal-session",agent:"old-agent",thinkingLevel:"low",accountId:"old-pin",accountIdExplicit:true})!;}
function state(status="paused"){return {id:"goal",sessionId:"fixture-goal-session",cwd:root,status,goal:"PRIVATE-AUTHORED-GOAL",acceptance:["criteria"],maxTurns:3,cooldownSeconds:0,turnCount:0,progress:[{time:"t",status:"progress",summary:"authored",token:"PRIVATE-TOKEN"}],initialImages:[{type:"image",mimeType:"image/png",data:"YQ==",token:"PRIVATE-TOKEN"}],token:"PRIVATE-TOKEN"};}
async function request(path:string,body?:unknown,method="GET",id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal){const result=await dispatchJsonBusinessRequest({route:path,method,url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:method==="GET"?undefined:id,signal,...(body===undefined||method==="GET"?{}:{body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))})});const dto=publicJsonBusinessResult(path,result,method);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};}
describe("Task Goal Loop Backend owner",()=>{
 it("GET is a real offline read, projects authored Goal/progress/images and finds persisted active loops without a session",async()=>{
  const row=task(),path=`tasks/${row.id}/goal-loop`,before=getTask(row.id),files=readdirSync(root);
  expect((await request(path)).body.loop).toBeNull();expect(readdirSync(root)).toEqual(files);expect(getTask(row.id)).toEqual(before);
  mkdirSync(join(root,"goals-loop"));writeFileSync(join(root,"goals-loop","fixture-goal-session.json"),JSON.stringify(state("queued")));
  const result=await request(path);expect(result.body.loop).toMatchObject({status:"queued",goal:"PRIVATE-AUTHORED-GOAL",progress:[{summary:"authored"}],initialImages:[{data:"YQ=="}]});expect(JSON.stringify(result.body)).not.toContain("PRIVATE-TOKEN");
  expect((await request("goal-loop/active")).body).toEqual({active:1,taskIds:[row.id]});expect(getTask(row.id)).toEqual(before);expect((await request("tasks/missing/goal-loop")).status).toBe(404);expect(readdirSync(root)).not.toContain("task-goal-loop-command.json");
 });
 it("start preserves normalized acceptance, clamped budget, selection and deep DTO; duplicate cannot start again",async()=>{
  const row=task(),path=`tasks/${row.id}/goal-loop`,cmd=vi.spyOn(harness,"goalLoopCommand").mockResolvedValue(state("queued") as never);
  const validate=vi.spyOn(harness,"validateTaskModelSelection").mockResolvedValue(),set=vi.spyOn(harness,"setTaskModel").mockImplementation(async id=>patchTask(id,{providerID:"new",modelID:"chosen",accountId:"new-pin",accountIdExplicit:true})!);
  const id=randomUUID(),start=await request(path,{action:"start",goal:" authored goal ",acceptance:"one\n\n two",model:"new-pin::new::chosen",maxTurns:1000,cooldownSeconds:5000,forceFullRun:true,fromBot:true,botId:"forged",restartPrompt:"forged"},"POST",id);
  expect(start.body).toMatchObject({loop:{status:"queued"},agent:"old-agent",operation:{id,execution:"complete"}});expect(JSON.stringify(start.body)).not.toContain("PRIVATE-TOKEN");
  expect(validate).toHaveBeenCalledWith("new-pin::new::chosen");expect(set).toHaveBeenCalledOnce();expect(cmd).toHaveBeenCalledWith(row.id,expect.objectContaining({action:"start",goal:"authored goal",acceptance:["one","two"],maxTurns:100,cooldownSeconds:5000,forceFullRun:true}));
  for(const key of ["fromBot","botId","restartPrompt"])expect(cmd.mock.calls[0][1]).not.toHaveProperty(key);
  expect((await request(path,{action:"start",goal:"duplicate"},"POST",id)).status).toBe(409);expect(cmd).toHaveBeenCalledOnce();expect(readFileSync(join(root,"task-goal-loop-command.json"),"utf8")).not.toContain("authored");
 });
 it("pause/resume/stop/complete must observe the durable action; final completed verification satisfies resume",async()=>{
  const row=task(),path=`tasks/${row.id}/goal-loop`,cmd=vi.spyOn(harness,"goalLoopCommand");vi.spyOn(relay,"botIdForCodeTask").mockReturnValue(undefined);
  for(const [action,status] of [["pause","paused"],["resume","queued"],["stop","stopped"],["complete","completed"],["resume","completed"]]){cmd.mockResolvedValueOnce(state(status) as never);expect((await request(path,{action,maxTurns:1000,restartPrompt:"forged"},"PATCH")).status).toBe(200);expect(cmd.mock.calls.at(-1)?.[1]).toEqual({action,maxTurns:action==="resume"?100:undefined});}
  for(const action of ["resume","stop","complete"]){cmd.mockResolvedValueOnce(state("paused") as never);expect((await request(path,{action},"PATCH")).status).toBe(409);}
 });
 it("delegated Code stop resolves the supervising Bot in the owner, ignoring forged botId",async()=>{
  const row=task(),resolve=vi.spyOn(relay,"botIdForCodeTask").mockReturnValue("owner-bot"),stop=vi.spyOn(harness,"stopBotCodeTask").mockResolvedValue(undefined as never),read=vi.spyOn(harness,"goalLoopState").mockResolvedValue(state("stopped") as never),cmd=vi.spyOn(harness,"goalLoopCommand");
  expect((await request(`tasks/${row.id}/goal-loop`,{action:"stop",botId:"forged"},"PATCH")).status).toBe(200);expect(resolve).toHaveBeenCalledWith(row.id);expect(stop).toHaveBeenCalledWith("owner-bot",row.id);expect(read).toHaveBeenCalledWith(row.id,{offline:true});expect(cmd).not.toHaveBeenCalled();
 });
 it("control is not queued behind Auto preparation and invalidates a cancelled start",async()=>{
  const row=task();let release!:(v:never)=>void;const auto=vi.spyOn(harness,"resolveAutoModel").mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const cmd=vi.spyOn(harness,"goalLoopCommand").mockImplementation(async(id,input)=>{invalidateTaskPreparations(id);return state(input.action==="stop"?"stopped":"paused") as never;});
  const id=randomUUID(),path=`tasks/${row.id}/goal-loop`,starting=request(path,{action:"start",goal:"fixture",auto:true},"POST",id);
  await vi.waitFor(()=>expect(auto).toHaveBeenCalledOnce());expect((await request(path,{action:"stop"},"PATCH")).status).toBe(200);expect((await starting).status).toBe(409);expect(cmd).toHaveBeenCalledOnce();release(null as never);expect((await request(path,{action:"start",goal:"repeat"},"POST",id)).status).toBe(409);
 });
 it("SDK selection failure rolls back best-effort; 5xx and disconnected accepted commands remain unknown/no-replay",async()=>{
  const row=task(),path=`tasks/${row.id}/goal-loop`;let finish!:(v:never)=>void;
  const cmd=vi.spyOn(harness,"goalLoopCommand").mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),controller=new AbortController(),id=randomUUID();
  const pending=request(path,{action:"pause"},"PATCH",id,true,undefined,controller.signal);await vi.waitFor(()=>expect(cmd).toHaveBeenCalledOnce());controller.abort();finish(state("paused") as never);expect((await pending).status).toBe(200);
  vi.spyOn(harness,"validateTaskModelSelection").mockResolvedValue();const model=vi.spyOn(harness,"setTaskModel").mockImplementation(async(id,value)=>patchTask(id,{modelID:value.includes("chosen")?"chosen":"old"})!);
  cmd.mockRejectedValue(new Error("PRIVATE SDK failure"));const failedId=randomUUID(),failed=await request(path,{action:"start",goal:"fixture",model:"p::chosen"},"POST",failedId);expect(failed.status).toBe(500);expect(failed.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(failed.body)).not.toContain("PRIVATE");expect(getTask(row.id)?.modelID).toBe("old");expect(model).toHaveBeenCalledTimes(2);expect((await request(path,{action:"start",goal:"fixture"},"POST",failedId)).status).toBe(409);
 });
 it("auth/Origin/bounds/IDs/input refuse before SDK and Next cannot read or command the owner's Goal",async()=>{
  const row=task(),path=`tasks/${row.id}/goal-loop`,cmd=vi.spyOn(harness,"goalLoopCommand"),files=readdirSync(root);
  expect((await request(path,undefined,"GET",randomUUID(),false)).status).toBe(401);expect((await request(path,{},"POST",randomUUID(),true,"https://evil.test")).status).toBe(403);expect((await request(path,"x".repeat(4097),"PATCH")).status).toBe(413);expect(readdirSync(root)).toEqual(files);
  for(const body of ["{",{action:"stop"},{action:"start",goal:" "},{action:"start",goal:"x".repeat(4001)},{action:"start",goal:"x",images:[{}]},{action:"start",goal:"x",auto:"true"}])expect((await request(path,body,"POST")).status).toBe(400);
  for(const body of [{},{action:"start"},{action:42}])expect((await request(path,body,"PATCH")).status).toBe(400);
  for(const id of ["..%2Fx","%252F"])for(const method of ["GET","POST","PATCH"])expect((await request(`tasks/${id}/goal-loop`,{action:"start",goal:"x"},method)).status).toBe(400);expect(cmd).not.toHaveBeenCalled();
  const beforeFiles=readdirSync(root);vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(startGoalLoopWithSelection(row.id,{goal:"x",auto:true})).rejects.toThrow("owned by Backend");
  for(const call of [()=>entrances.goalLoopState(row.id,{offline:true}),()=>entrances.goalLoopCommand(row.id,{action:"stop"}),()=>entrances.activeGoalLoopTaskIds()])expect(call).toThrow("owned by Backend");await expect(request(path)).rejects.toThrow("owned by Backend");expect(readdirSync(root)).toEqual(beforeFiles);
 });
});

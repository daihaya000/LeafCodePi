import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { createPermissionPromptService, createQuestionPromptService } from "@backend-core/pending-prompts.mjs";
import { insertTask, patchTask, getTask } from "@/lib/store";
import * as harness from "@/lib/pi/harness";
import * as entrances from "@backend-runtime/lib/task-conversation";
import { handleTaskPrompt } from "@/lib/pi/task-prompt";
const host=globalThis as unknown as Record<string,unknown>;
const keys=["__leafcodePiPermissionPromptService","__leafcodePiQuestionPromptService"];
const previous=keys.map(key=>host[key]);
const options={resolveTaskId:(id:string)=>id.startsWith("session:")?id.slice(8):null,emit:()=>{},snapshotExtras:()=>({})};
const permission=createPermissionPromptService(options),question=createQuestionPromptService(options);
host[keys[0]]=permission;host[keys[1]]=question;
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-task-conversation-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{permission.dispose();question.dispose();vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
afterAll(()=>keys.forEach((key,i)=>{if(previous[i]===undefined)delete host[key];else host[key]=previous[i];}));
function task(){const row=insertTask({project:null,title:"Conversation",providerID:"fixture",modelID:"fixture"});return patchTask(row.id,{directory:root})!;}
async function request(path:string,body:unknown,id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal){
 const result=await dispatchJsonBusinessRequest({route:path,method:"POST",url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:id,signal,body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))});
 const dto=publicJsonBusinessResult(path,result);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};
}
describe("Task conversation Backend owner",()=>{
 it("consumes real FIFO permissions only for the owning task and head request; false is denial",async()=>{
  const row=task(),path=`tasks/${row.id}/permission`;
  const a=permission.handleRequest({id:"perm-a",sessionId:`session:${row.id}`,command:"fixture read",labels:[],message:"Fixture-only decision"}),b=permission.handleRequest({id:"perm-b",sessionId:`session:${row.id}`,command:"fixture read",labels:[],message:"Fixture-only decision"});
  expect((await request("tasks/foreign/permission",{requestId:"perm-a",approved:true})).status).toBe(404);
  expect((await request(path,{requestId:"perm-b",approved:true})).status).toBe(404);
  expect(permission.pendingForTask(row.id)?.id).toBe("perm-a");
  const id=randomUUID(),denied=await request(path,{requestId:" perm-a ",approved:false},id);expect(denied.body).toMatchObject({ok:true,operation:{id,execution:"complete"}});expect(await a).toBe(false);
  expect((await request(path,{requestId:"perm-b",approved:true},id)).status).toBe(409);expect(permission.pendingForTask(row.id)?.id).toBe("perm-b");
  expect((await request(path,{requestId:"perm-b",approved:true})).status).toBe(200);expect(await b).toBe(true);
  expect((await request(path,{requestId:"perm-a",approved:true})).status).toBe(404);expect(readFileSync(join(root,"task-conversation-command.json"),"utf8")).not.toContain("perm-");
 });
 it("questions preserve answers, rejection and expiry without persisting authored input",async()=>{
  const row=task(),path=`tasks/${row.id}/question`,answers=[["PRIVATE-AUTHORED 日本語"],["two","three"]];
  const pending=question.handleRequest({id:"question-a",sessionId:`session:${row.id}`,questions:[]});
  expect((await request(path,{requestId:"question-a",answers})).status).toBe(200);expect(await pending).toEqual({answers});
  const rejected=question.handleRequest({id:"question-b",sessionId:`session:${row.id}`,questions:[]});expect((await request(path,{requestId:"question-b",reject:true,answers:123})).body.ok).toBe(true);expect(await rejected).toBeNull();
  expect((await request(path,{requestId:"question-b",reject:true})).status).toBe(404);expect(readFileSync(join(root,"task-conversation-command.json"),"utf8")).not.toContain("PRIVATE");
 });
 it("prompt admission preserves SDK selection/steer/resume and strips internal privilege fields",async()=>{
  const row=task();const sdk=vi.spyOn(harness,"promptTask").mockResolvedValue({...row,responseModel:{providerID:"p",modelID:"m",token:"PRIVATE"},credentials:"PRIVATE"} as never);
  const id=randomUUID(),path=`tasks/${row.id}/prompt`,body={prompt:"PRIVATE-PROMPT",streamingBehavior:"steer",interruptIfSafe:true,resume:true,permissionMode:"allow",subagentPermission:"allow",skillPermission:"allow",waitForCompletion:true,fromBot:true,codeRequestId:"forged",accountIdExplicit:true};
  const sent=await request(path,body,id);expect(sent.body.operation).toEqual({id,execution:"complete"});expect(JSON.stringify(sent.body)).not.toContain("PRIVATE");
  expect(sdk).toHaveBeenCalledWith(row.id,"PRIVATE-PROMPT",undefined,expect.objectContaining({streamingBehavior:"steer",interruptIfSafe:true,resume:true}));
  for(const key of ["permissionMode","subagentPermission","skillPermission","waitForCompletion","fromBot","codeRequestId","accountIdExplicit"])expect(sdk.mock.calls[0][3]).not.toHaveProperty(key);
  expect((await request(path,body,id)).status).toBe(409);expect(sdk).toHaveBeenCalledTimes(1);expect(readFileSync(join(root,"task-conversation-command.json"),"utf8")).not.toContain("PRIVATE");
 });
 it("an accepted prompt survives disconnect while answers and a real Stop remain unblocked during Auto preparation",async()=>{
  const row=task();let release!:(v:never)=>void;
  const auto=vi.spyOn(harness,"resolveAutoModel").mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const sdk=vi.spyOn(harness,"promptTask").mockResolvedValue(row);
  const controller=new AbortController(),id=randomUUID(),path=`tasks/${row.id}/prompt`;
  const sending=request(path,{prompt:"fixture",auto:true},id,true,undefined,controller.signal);
  await vi.waitFor(()=>expect(auto).toHaveBeenCalledOnce());controller.abort();
  const pending=question.handleRequest({id:"while-preparing",sessionId:`session:${row.id}`,questions:[]});expect((await request(`tasks/${row.id}/question`,{requestId:"while-preparing",reject:true})).status).toBe(200);expect(await pending).toBeNull();
  expect((await request(`tasks/${row.id}/abort`,{})).status).toBe(200);
  const stopped=await sending;expect(stopped.status).toBe(409);expect(stopped.body).toMatchObject({operation:{execution:"complete"}});expect(sdk).not.toHaveBeenCalled();release(null as never);
  expect((await request(path,{prompt:"repeat"},id)).status).toBe(409);
 });
 it("disconnect alone cannot retract admission; an SDK failure is unknown and never repeated",async()=>{
  const row=task();let accept!:(v:typeof row)=>void;const sdk=vi.spyOn(harness,"promptTask").mockImplementation(()=>new Promise(resolve=>{accept=resolve;}));
  const controller=new AbortController(),id=randomUUID(),path=`tasks/${row.id}/prompt`,sending=request(path,{prompt:"fixture"},id,true,undefined,controller.signal);await vi.waitFor(()=>expect(sdk).toHaveBeenCalledOnce());controller.abort();accept(row);expect((await sending).status).toBe(200);
  sdk.mockRejectedValue(new Error("PRIVATE partial SDK failure"));const failedId=randomUUID(),failed=await request(path,{prompt:"fixture"},failedId);expect(failed.status).toBe(500);expect(failed.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(failed.body)).not.toContain("PRIVATE");
  expect((await request(path,{prompt:"fixture"},failedId)).status).toBe(409);expect(sdk).toHaveBeenCalledTimes(2);
 });
 it("auth, Origin, bounded UTF-8 bodies and unsafe IDs refuse before SDK effects",async()=>{
  const row=task(),sdk=vi.spyOn(harness,"promptTask"),permissionSpy=vi.spyOn(harness,"respondToPermissionPrompt"),questionSpy=vi.spyOn(harness,"respondToQuestionPrompt"),files=readdirSync(root);
  for(const suffix of ["prompt","permission","question"]){const path=`tasks/${row.id}/${suffix}`;expect((await request(path,{},randomUUID(),false)).status).toBe(401);expect((await request(path,{},randomUUID(),true,"https://evil.test")).status).toBe(403);}
  expect((await request(`tasks/${row.id}/permission`,"x".repeat(4097))).status).toBe(413);expect((await request(`tasks/${row.id}/question`,"x".repeat(16385))).status).toBe(413);expect(readdirSync(root)).toEqual(files);
  for(const suffix of ["prompt","permission","question"])for(const id of ["..%2Fx","%252F"])expect((await request(`tasks/${id}/${suffix}`,{prompt:"fixture",requestId:"r",approved:true,reject:true})).status).toBe(400);
  for(const body of ["{",{}, {prompt:32},{prompt:"x",images:[{}]},{prompt:"x",model:42},{prompt:"x",autoRetry:true},{prompt:"x",interruptIfSafe:true}])expect((await request(`tasks/${row.id}/prompt`,body)).status).toBe(400);
  for(const body of [{requestId:42,reject:true},{requestId:"r",reject:"true"},{requestId:"r",answers:["x"]},{requestId:"r",answers:[[" "]]},{requestId:"r",answers:[[false]]}])expect((await request(`tasks/${row.id}/question`,body)).status).toBe(400);
  expect(sdk).not.toHaveBeenCalled();expect(permissionSpy).not.toHaveBeenCalled();expect(questionSpy).not.toHaveBeenCalled();
 });
 it("Next cannot enter prompt preparation, SDK submission, pending responses or the ledger",async()=>{
  const row=task(),before=getTask(row.id),files=readdirSync(root);vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
  await expect(handleTaskPrompt(row.id,{prompt:"fixture",auto:true})).rejects.toThrow("owned by Backend");
  for(const action of [()=>entrances.promptTask(row.id,"fixture"),()=>entrances.respondToPermissionPrompt(row.id,"r",true),()=>entrances.respondToQuestionPrompt(row.id,"r",null)])expect(action).toThrow("owned by Backend");
  await expect(request(`tasks/${row.id}/prompt`,{prompt:"fixture"})).rejects.toThrow("owned by Backend");expect(getTask(row.id)).toEqual(before);expect(readdirSync(root)).toEqual(files);
 });
});

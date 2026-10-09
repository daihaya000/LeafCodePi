import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as harness from "@/lib/pi/harness";
import * as store from "@/lib/store";
import * as titles from "@/lib/direct-title";
import * as generation from "@/lib/direct-generation";
import * as settings from "@/lib/pi/web-settings";
import * as directSession from "@/lib/direct-session";
import * as entrances from "@backend-runtime/lib/task-assistance";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { taskAssistanceBodyLimit } from "@shared/task-assistance-contract.mjs";
let root: string;
const task=()=>({id:"t",status:"idle",title:"Fixture",providerID:"p",modelID:"m",accountId:"a",accountIdExplicit:true,sessionFile:"fixture",token:"PRIVATE"} as NonNullable<ReturnType<typeof store.getTask>> & { token: string });
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-assistance-owner-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
async function request(action="title",body:unknown={},method="POST",id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal,taskId="t"){
 const path=`tasks/${taskId}/${action}`,result=await dispatchJsonBusinessRequest({route:path,method,url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:id,signal,body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))});
 const dto=publicJsonBusinessResult(path,result,method);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};
}
describe("Task assistance Backend owner",()=>{
 it("title owns manual sanitization and opt-out persistence; ACK matches and ledger stores no title",async()=>{
  const patch=vi.spyOn(store,"patchTask").mockImplementation((_id,value)=>({...task(),...value} as never));
  const id=randomUUID(),result=await request("title",{title:" PRIVATE-TITLE-日本語 ",unknown:"ignore"},"PATCH",id);
  expect(result.status).toBe(200);expect(patch).toHaveBeenCalledExactlyOnceWith("t",{title:"PRIVATE-TITLE-日本語",titleAutoUpdate:false});expect(result.body).toMatchObject({title:"PRIVATE-TITLE-日本語",task:{titleAutoUpdate:false},operation:{id,execution:"complete"}});
  expect((result.body.task as any).token).toBeUndefined();expect((await request("title",{},"PATCH",id)).status).toBe(409);
  expect(readFileSync(join(root,"task-assistance-command.json"),"utf8")).not.toContain("PRIVATE");
  expect((await request("title",{titleAutoUpdate:true},"PATCH")).status).toBe(200);expect(patch.mock.calls.at(-1)).toEqual(["t",{titleAutoUpdate:true}]);
 });
 it("generated title and label-only reuse owner semantics, without forwarding caller privilege fields",async()=>{
  const title=vi.spyOn(titles,"refreshTaskTitleDirect").mockResolvedValue({title:"日本語",task:task(),model:{providerID:"p",modelID:"m",token:"PRIVATE"} as never}),label=vi.spyOn(titles,"refreshTaskLabelDirect").mockResolvedValue({task:task()});
  expect((await request("title",{model:{providerID:"p",modelID:"m",accountId:"chosen",token:"forged"},fromBot:true,botId:"forged"})).body).toMatchObject({title:"日本語",model:{providerID:"p",modelID:"m"}});
  expect(title).toHaveBeenCalledExactlyOnceWith("t",{providerID:"p",modelID:"m",accountId:"chosen"});
  expect((await request("title",{labelOnly:true})).status).toBe(200);expect(label).toHaveBeenCalledExactlyOnceWith("t");
  expect((await request("title",{labelOnly:1})).status).toBe(400);
 });
 it("pending permission advice reads the owner's matching FIFO only and never answers or executes",async()=>{
  vi.spyOn(store,"getTask").mockReturnValue(task());
  const permission=vi.spyOn(harness,"pendingPermissionForTask").mockReturnValue({id:"r",command:"rm <private>",labels:["danger"],token:"PRIVATE"} as never);
  const answer=vi.spyOn(harness,"respondToPermissionPrompt"),generate=vi.spyOn(generation,"generateDirectTextWithFallbackResult").mockResolvedValue({text:" 日本語助言 ",model:{providerID:"p",modelID:"m"}});
  // Use the actual generation key rather than trusting a caller model or caller command.
  const key=(await import("@/lib/generation-model-key")).GENERATION_MODEL_SETTING_KEY;vi.spyOn(settings,"getSetting").mockImplementation(k=>k===key?"p::m":"");
  const result=await request("permission/advice",{requestId:"r",command:"FORGED",allow:true,model:{providerID:"forged",modelID:"forged"}});
  expect(result.status).toBe(200);expect(result.body).toMatchObject({advice:"日本語助言",source:"direct"});expect(permission).toHaveBeenCalledWith("t");expect(generate.mock.calls[0][0]).toMatchObject({accountId:"a",accountIdExplicit:true});expect(generate.mock.calls[0][0].prompt).toContain("rm ＜private＞");expect(generate.mock.calls[0][0].prompt).not.toContain("FORGED");expect(answer).not.toHaveBeenCalled();
  expect((await request("permission/advice",{requestId:"wrong"})).status).toBe(404);expect(generate).toHaveBeenCalledOnce();
 });
 it("only progress forwards disconnect cancellation; concurrent title edits and other generation survive disconnect",async()=>{
  vi.spyOn(settings,"getSetting").mockReturnValue("");vi.spyOn(store,"getTask").mockReturnValue(task());vi.spyOn(directSession,"readSessionConversation").mockReturnValue([{role:"user",text:"authored conversation"}]);
  vi.spyOn(harness,"readTaskProgressSnapshot").mockResolvedValue({task:task(),messages:[{id:"u",role:"user",createdAt:1,parts:[{id:"p",type:"text",text:"authored"}]}],todos:[],isStreaming:false,isCompacting:false,goalLoop:null,pendingPermission:null,pendingQuestion:null} as never);
  const generate=vi.spyOn(generation,"generateDirectTextWithFallbackResult").mockImplementation(options=>new Promise((_resolve,reject)=>{options.signal!.addEventListener("abort",()=>reject(new Error("PRIVATE aborted")),{once:true});}));
  const patch=vi.spyOn(store,"patchTask").mockImplementation((_id,value)=>({...task(),...value} as never)),controller=new AbortController(),id=randomUUID();
  const pending=request("progress",{question:"確認"},"POST",id,true,undefined,controller.signal);await vi.waitFor(()=>expect(generate).toHaveBeenCalledOnce());
  expect((await request("title",{title:"Manual"},"PATCH")).status).toBe(200);expect(patch).toHaveBeenCalledOnce();controller.abort();
  const cancelled=await pending;expect(cancelled.status).toBe(502);expect(cancelled.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(cancelled.body)).not.toContain("PRIVATE");expect((await request("progress",{},"POST",id)).status).toBe(409);
  generate.mockResolvedValueOnce({text:"次の一手",model:{providerID:"p",modelID:"m"}});const disconnected=new AbortController();disconnected.abort();expect((await request("next-action",{},"POST",randomUUID(),true,undefined,disconnected.signal)).status).toBe(200);expect(generate.mock.calls.at(-1)![0].signal).toBeUndefined();
 });
 it("bad successful owner projections and provider errors remain unknown, not replayable complete",async()=>{
  const title=vi.spyOn(titles,"refreshTaskTitleDirect").mockResolvedValue({task:null,title:"done"} as never);
  for(const failure of ["malformed","provider"]){if(failure==="provider")title.mockRejectedValueOnce(new Error("PRIVATE provider"));const id=randomUUID(),result=await request("title",{},"POST",id);expect(result.status).toBe(failure==="malformed"?503:502);expect(result.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect((await request("title",{},"POST",id)).status).toBe(409);}
 });
 it("auth/Origin/bounds and invalid IDs refuse before business effects; Next entrances refuse all reads/effects",async()=>{
  const read=vi.spyOn(store,"getTask"),patch=vi.spyOn(store,"patchTask"),snapshot=vi.spyOn(harness,"readTaskProgressSnapshot"),pending=vi.spyOn(harness,"pendingPermissionForTask"),title=vi.spyOn(titles,"refreshTaskTitleDirect"),label=vi.spyOn(titles,"refreshTaskLabelDirect"),files=readdirSync(root);
  for(const action of ["progress","next-action","title","permission/advice"]){expect((await request(action,{},"POST",randomUUID(),false)).status).toBe(401);expect((await request(action,{},"POST",randomUUID(),true,"https://evil.test")).status).toBe(403);expect((await request(action,"x".repeat(taskAssistanceBodyLimit("tasks/t/"+action)+1))).status).toBe(413);}
  expect(readdirSync(root)).toEqual(files);
  for(const id of ["..%2Fx","%252F"])expect((await request("title",{},"POST",randomUUID(),true,undefined,undefined,id)).status).toBe(400);
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
  for(const fn of [()=>entrances.getTask("t"),()=>entrances.patchTask("t",{title:"x"}),()=>entrances.readTaskProgressSnapshot("t"),()=>entrances.pendingPermissionForTask("t"),()=>entrances.refreshTaskTitleDirect("t"),()=>entrances.refreshTaskLabelDirect("t")])expect(fn).toThrow("owned by Backend");
  await expect(request("title")).rejects.toThrow("owned by Backend");
  for(const spy of [read,patch,snapshot,pending,title,label])expect(spy).not.toHaveBeenCalled();
 });
});

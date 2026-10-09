import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import * as bots from "@/lib/bots";
import * as harness from "@/lib/pi/harness";
import * as relay from "@/lib/pi/bot-code-relay";
import * as entrances from "@backend-runtime/lib/bot-conversation";
import { startBotGoalLoop } from "@/lib/pi/bot-goal-loop-start";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
const botId="11111111-0123-4321-abcd-eeeeeeeeeeee",taskId="bot:"+botId;
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-bot-conversation-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const summary=()=>({id:taskId,status:"working",token:"PRIVATE"} as never);
const detail=()=>({id:taskId,status:"idle",isStreaming:false,messages:[{id:"user",role:"user",createdAt:1,parts:[{id:"text",type:"text",text:"authored 日本語"}],token:"PRIVATE"}],token:"PRIVATE"} as never);
const loop=()=>({id:"loop",sessionId:"owner-session",status:"queued",goal:"authored",acceptance:["owner"],progress:[{time:"1",status:"progress",summary:"authored",token:"PRIVATE"}],token:"PRIVATE"} as never);
const exists=()=>vi.spyOn(bots,"getBot").mockReturnValue({id:botId,enabled:false} as never);
async function request(action="prompt",body:unknown={prompt:"authored 日本語"},id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal,selector=botId){const path=`bots/${selector}/${action}`,result=await dispatchJsonBusinessRequest({route:path,method:"POST",url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:id,signal,body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))});const dto=publicJsonBusinessResult(path,result,"POST");expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};}
describe("Bot conversation Backend owner",()=>{
 it("uses only the owner's Bot selector and authored prompt/UTF-8 attachments; no caller internal privileges",async()=>{
  exists();const prompt=vi.spyOn(harness,"promptTask").mockResolvedValue(summary()),id=randomUUID(),images=[{mimeType:"image/png",data:"aW1hZ2U="}],files=[{name:"memo.txt",mimeType:"text/plain",data:"5pel5pys6Kqe"}];
  const accepted=await request("prompt",{prompt:"authored 日本語",images,files,botId:"forged",taskId:"other",model:"forged",agent:"forged",fromBot:true,codeRequestId:"forged",permissionMode:"allow",waitForCompletion:true},id);
  expect(accepted.status).toBe(200);expect(accepted.body).toMatchObject({task:{id:taskId},operation:{id,execution:"complete"}});expect(JSON.stringify(accepted.body)).not.toContain("PRIVATE");expect(prompt).toHaveBeenCalledExactlyOnceWith(taskId,"authored 日本語",images,{files});
  expect((await request("prompt",{},id)).status).toBe(409);expect(prompt).toHaveBeenCalledOnce();const ledger=readFileSync(join(root,"bot-conversation-command.json"),"utf8");for(const text of [botId,"authored","forged",files[0].data])expect(ledger).not.toContain(text);
 });
 it("Goal options normalize/clamp at owner and busy/invalid/refused starts cause no ordinary send",async()=>{
  exists();const goal=vi.spyOn(harness,"goalLoopCommand").mockResolvedValue(loop()),busy=vi.spyOn(harness,"isTaskRuntimeBusyForGoalLoopStart").mockReturnValue(false),prompt=vi.spyOn(harness,"promptTask"),images=[{mimeType:"image/png",data:"aW1hZ2U="}];
  const result=await request("prompt",{prompt:"authored",images,goalLoop:{acceptance:[" owner "],maxTurns:1000,cooldownSeconds:999999,forceFullRun:true,autoAgent:true},model:"forged"});expect(result.status).toBe(200);expect(result.body).toMatchObject({task:null,loop:{status:"queued",progress:[{summary:"authored"}]}});expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect(goal).toHaveBeenCalledExactlyOnceWith(taskId,{action:"start",goal:"authored",images,acceptance:["owner"],maxTurns:100,cooldownSeconds:86400,forceFullRun:true});expect(prompt).not.toHaveBeenCalled();
  busy.mockReturnValueOnce(true);expect((await request("prompt",{prompt:"x",goalLoop:{}})).status).toBe(409);expect(goal).toHaveBeenCalledOnce();
  for(const body of [{prompt:"x",goalLoop:{acceptance:"bad"}},{prompt:"x",goalLoop:{maxTurns:{}}},{prompt:"x",goalLoop:{forceFullRun:"true"}},{prompt:"x",goalLoop:{},files:[{name:"a.txt",mimeType:"text/plain",data:"aGk="}]}])expect((await request("prompt",body)).status).toBe(400);expect(goal).toHaveBeenCalledOnce();
 });
 it("Stop is concurrent with held session/Goal preparation and admitted disconnect cannot undo owner work",async()=>{
  exists();let finish!:(value:never)=>void;const prompt=vi.spyOn(harness,"promptTask").mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),stop=vi.spyOn(harness,"stopBotCodeTask").mockResolvedValue(summary()),controller=new AbortController(),id=randomUUID();
  const held=request("prompt",{prompt:"held"},id,true,undefined,controller.signal);await vi.waitFor(()=>expect(prompt).toHaveBeenCalledOnce());expect((await request("abort",{botId:"forged",taskId:"other",action:"delete"})).status).toBe(200);expect(stop).toHaveBeenCalledExactlyOnceWith(botId,taskId);controller.abort();finish(summary());expect((await held).status).toBe(200);expect((await request("prompt",{},id)).status).toBe(409);
 });
 it("rewind returns authored tree/attachments and cancels only owner 1:1 outbox after a successful edit",async()=>{
  exists();const reverted={task:detail(),text:"authored 日本語",images:[{uri:"data:image/png;base64,AQ==",mime:"image/png",token:"PRIVATE"}],files:[{uri:"data:text/plain;base64,aGk=",mime:"text/plain",name:"a.txt",token:"PRIVATE"}]},edit=vi.spyOn(harness,"revertTask").mockResolvedValue(reverted as never),cancel=vi.spyOn(relay,"cancelBotCodeRequests").mockResolvedValue(2);
  const result=await request("revert",{entryId:" user ",botId:"other",action:"delete"});expect(result.status).toBe(200);expect(result.body).toMatchObject({text:"authored 日本語",cancelledCodeRequests:2,task:{messages:[{parts:[{text:"authored 日本語"}]}]}});expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect(edit).toHaveBeenCalledExactlyOnceWith(taskId,"user");expect(cancel).toHaveBeenCalledExactlyOnceWith(botId);expect(edit.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]);
  edit.mockRejectedValueOnce(Object.assign(new Error("busy"),{status:409}));expect((await request("revert",{entryId:"user"})).status).toBe(409);expect(cancel).toHaveBeenCalledOnce();
  cancel.mockRejectedValueOnce(Object.assign(new Error("PRIVATE partial outbox/path"),{status:409}));const id=randomUUID(),partial=await request("revert",{entryId:"user"},id);expect(partial.status).toBe(503);expect(partial.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(partial.body)).not.toContain("PRIVATE");expect((await request("revert",{},id)).status).toBe(409);
 });
 it("malformed SDK success and private exceptions remain unknown; replay never calls provider/teardown again",async()=>{
  exists();const prompt=vi.spyOn(harness,"promptTask").mockResolvedValueOnce({} as never),stop=vi.spyOn(harness,"stopBotCodeTask").mockRejectedValueOnce(new Error("PRIVATE"));
  for(const [action,body] of [["prompt",{prompt:"x"}],["abort",{}]] as const){const id=randomUUID(),result=await request(action,body,id);expect(result.status).toBeGreaterThanOrEqual(500);expect(result.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect((await request(action,body,id)).status).toBe(409);}expect(prompt).toHaveBeenCalledOnce();expect(stop).toHaveBeenCalledOnce();
 });
 it("auth/Origin/bounds/selectors/entry IDs and Next entrances refuse before SDK/Bot/store/outbox access",async()=>{
  const get=vi.spyOn(bots,"getBot"),prompt=vi.spyOn(harness,"promptTask"),goal=vi.spyOn(harness,"goalLoopCommand"),stop=vi.spyOn(harness,"stopBotCodeTask"),edit=vi.spyOn(harness,"revertTask"),cancel=vi.spyOn(relay,"cancelBotCodeRequests"),before=readdirSync(root);
  for(const action of ["prompt","abort","revert"])expect((await request(action,{},randomUUID(),false)).status).toBe(401);
  expect((await request("prompt",{},randomUUID(),true,"https://evil.test")).status).toBe(403);expect((await request("abort","x".repeat(4097))).status).toBe(413);expect((await request("prompt","x".repeat(18*1024*1024+1))).status).toBe(413);expect(readdirSync(root)).toEqual(before);
  for(const id of ["..%2Fx","%252F","invalid"])for(const action of ["prompt","abort","revert"])expect((await request(action,{},randomUUID(),true,undefined,undefined,id)).status).toBe(400);expect(get).not.toHaveBeenCalled();
  get.mockReturnValue({id:botId} as never);for(const entryId of [""," ","x".repeat(257),"bad\u0000id"])expect((await request("revert",{entryId})).status).toBe(400);get.mockClear();
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");for(const fn of [()=>entrances.readConversationBot(botId),()=>entrances.promptBotConversation(botId,"x"),()=>entrances.startBotConversationGoal(botId,{goal:"x"}),()=>entrances.abortBotConversation(botId)])expect(fn).toThrow("owned by Backend");await expect(entrances.revertBotConversation(botId,"user")).rejects.toThrow("owned by Backend");await expect(startBotGoalLoop(botId,{goal:"x"})).rejects.toThrow("owned by Backend");await expect(request()).rejects.toThrow("owned by Backend");for(const spy of [get,prompt,goal,stop,edit,cancel])expect(spy).not.toHaveBeenCalled();
 });
});

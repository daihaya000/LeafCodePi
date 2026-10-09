import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as harness from "@/lib/pi/harness";
import * as entrances from "@backend-runtime/lib/task-compaction";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { TASK_COMPACTION_BODY_LIMIT } from "@shared/task-compaction-contract.mjs";
import { MAX_PROMPT_TEXT_CHARS } from "@/lib/prompt-images";
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-compact-owner-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const detail=(compacting=false)=>({id:"t",status:"idle",isStreaming:false,isCompacting:compacting,messages:[{id:"c",role:"compaction",createdAt:1,parts:[{id:"p",type:"text",text:"authored summary",token:"PRIVATE"}]}],token:"PRIVATE"} as never);
async function request(action="compact",body?:unknown,id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal,taskId="t"){
 const path=`tasks/${taskId}/${action}`,result=await dispatchJsonBusinessRequest({route:path,method:"POST",url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:id,signal,...(body===undefined?{}:{body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))})});
 const dto=publicJsonBusinessResult(path,result);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};
}
describe("Task compaction Backend owner",()=>{
 it("only authored focus enters the SDK, deep detail is scrubbed and replay/ledger never record focus",async()=>{
  const compact=vi.spyOn(harness,"compactTask").mockResolvedValue(detail()),id=randomUUID();
  const result=await request("compact",{customInstructions:"PRIVATE-AUTHORED-FOCUS",model:"forged",accountId:"forged",fromBot:true,botId:"forged",auto:true},id);
  expect(result.status).toBe(200);expect(result.body).toMatchObject({task:{messages:[{parts:[{text:"authored summary"}]}]},operation:{id,execution:"complete"}});
  expect(JSON.stringify(result.body)).not.toContain("PRIVATE");expect(compact).toHaveBeenCalledExactlyOnceWith("t","PRIVATE-AUTHORED-FOCUS");
  expect((await request("compact",{},id)).status).toBe(409);expect(compact).toHaveBeenCalledOnce();expect(readFileSync(join(root,"task-compaction-command.json"),"utf8")).not.toContain("PRIVATE");
 });
 it("maximum scalar Unicode/control focus is compatible, while owner validation rejects malformed/overlong input",async()=>{
  const compact=vi.spyOn(harness,"compactTask").mockResolvedValue(detail());
  for(const char of ["漢","😀","\u0000"]){const focus=char.repeat(MAX_PROMPT_TEXT_CHARS);expect((await request("compact",{customInstructions:focus})).status).toBe(200);expect(compact.mock.calls.at(-1)).toEqual(["t",focus]);}
  expect((await request("compact",{})).status).toBe(200);expect(compact.mock.calls.at(-1)).toEqual(["t",undefined]);
  for(const body of [undefined,null,[],123,"{",{customInstructions:2},{customInstructions:null}])expect((await request("compact",body)).status).toBe(400);
  for(const char of ["x","漢","😀"])expect((await request("compact",{customInstructions:char.repeat(MAX_PROMPT_TEXT_CHARS+1)})).status).toBe(413);
  expect(compact).toHaveBeenCalledTimes(4);
 });
 it("abort is admitted while compaction awaits its provider, and does not claim a noncooperative provider has settled",async()=>{
  let finish!:(v:never)=>void;const compact=vi.spyOn(harness,"compactTask").mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),abort=vi.spyOn(harness,"abortTaskCompaction").mockResolvedValue(detail(true));
  const started=request("compact",{});await vi.waitFor(()=>expect(compact).toHaveBeenCalledOnce());
  const id=randomUUID(),stopping=await request("compact/abort",{customInstructions:"ignored",model:"forged"},id);expect(stopping.status).toBe(200);expect(stopping.body).toMatchObject({task:{isCompacting:true},operation:{execution:"complete"}});expect(abort).toHaveBeenCalledExactlyOnceWith("t");
  expect((await request("compact/abort",undefined,id)).status).toBe(409);finish(detail());expect((await started).status).toBe(200);
 });
 it("accepted disconnect continues once; SDK failure and invalid success are unknown, with no replay",async()=>{
  let finish!:(v:never)=>void;const compact=vi.spyOn(harness,"compactTask").mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),controller=new AbortController(),id=randomUUID();
  const pending=request("compact",{},id,true,undefined,controller.signal);await vi.waitFor(()=>expect(compact).toHaveBeenCalledOnce());controller.abort();finish(detail());expect((await pending).status).toBe(200);expect((await request("compact",{},id)).status).toBe(409);
  compact.mockRejectedValueOnce(new Error("PRIVATE provider failure"));const failedId=randomUUID(),failed=await request("compact",{},failedId);expect(failed.status).toBe(500);expect(failed.body).toMatchObject({operation:{execution:"unknown"}});expect(JSON.stringify(failed.body)).not.toContain("PRIVATE");expect((await request("compact",{},failedId)).status).toBe(409);
  compact.mockResolvedValueOnce({id:"t"} as never);const invalid=await request("compact",{});expect(invalid.status).toBe(503);expect(invalid.body).toMatchObject({operation:{execution:"unknown"}});
 });
 it("SDK cancellation/no-history/already-compact/busy/unknown task retain their owner refusal, not fabricated success",async()=>{
  const compact=vi.spyOn(harness,"compactTask");
  for(const [status,error] of [[400,"圧縮をキャンセルしました"],[400,"圧縮するほど履歴がありません"],[400,"すでに圧縮済みです"],[409,"コンテキスト圧縮は既に実行中です"],[404,"タスクが見つかりません"]] as const){compact.mockRejectedValueOnce(Object.assign(new Error(error),{status}));const result=await request("compact",{});expect(result.status).toBe(status);expect(result.body).toMatchObject({error,operation:{execution:"complete"}});}
  vi.spyOn(harness,"abortTaskCompaction").mockRejectedValueOnce(Object.assign(new Error("タスクが見つかりません"),{status:404}));expect((await request("compact/abort")).status).toBe(404);
 });
 it("auth/Origin/bounds precede SDK and admission; invalid IDs refuse owner-side and Next entrances do nothing",async()=>{
  const compact=vi.spyOn(harness,"compactTask"),abort=vi.spyOn(harness,"abortTaskCompaction"),before=readdirSync(root);
  expect((await request("compact",{},randomUUID(),false)).status).toBe(401);expect((await request("compact",{},randomUUID(),true,"https://evil.test")).status).toBe(403);
  expect((await request("compact","x".repeat(TASK_COMPACTION_BODY_LIMIT+1))).status).toBe(413);expect((await request("compact/abort","x".repeat(4097))).status).toBe(413);expect(readdirSync(root)).toEqual(before);
  for(const action of ["compact","compact/abort"])for(const taskId of ["..%2Fx","%252F"])expect((await request(action,{},randomUUID(),true,undefined,undefined,taskId)).status).toBe(400);
  expect(compact).not.toHaveBeenCalled();expect(abort).not.toHaveBeenCalled();const files=readdirSync(root);vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
  expect(()=>entrances.compactTask("t")).toThrow("owned by Backend");expect(()=>entrances.abortTaskCompaction("t")).toThrow("owned by Backend");await expect(request("compact",{})).rejects.toThrow("owned by Backend");expect(readdirSync(root)).toEqual(files);expect(compact).not.toHaveBeenCalled();expect(abort).not.toHaveBeenCalled();
 });
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as harness from "@/lib/pi/harness";
import * as fork from "@/lib/pi/task-fork";
import * as entrances from "@backend-runtime/lib/task-session";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-session-owner-"));vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent"));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const task={id:"t",status:"idle",token:"PRIVATE"} as never;
const detail={id:"t",status:"idle",isStreaming:false,messages:[],token:"PRIVATE"} as never;
const draft={text:"PRIVATE-AUTHORED-DRAFT",images:[{uri:"data:image/png;base64,YQ==",mime:"image/png",token:"PRIVATE"}],files:[]};
async function request(action:string,body?:unknown,id=randomUUID(),authorized=true,origin?:string,signal?:AbortSignal,taskId="t") {
 const path=`tasks/${taskId}/${action}`;
 const result=await dispatchJsonBusinessRequest({route:path,method:"POST",url:`http://localhost/api/${path}`,headers:{host:"localhost",...(origin?{origin}:{})},authorized,operationId:id,signal,...(body===undefined?{}:{body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))})});
 const dto=publicJsonBusinessResult(path,result);expect(dto).not.toBeNull();return {...dto!,body:dto!.body!};
}
describe("Task session Backend owner",()=>{
 it.each(["fork","revert","unrevert","promote"])("owns %s validation, draft/detail/project DTO and no-replay admission",async action=>{
  const op=action==="fork"?vi.spyOn(fork,"forkTask").mockResolvedValue({task,...draft} as never):action==="revert"?vi.spyOn(harness,"revertTask").mockResolvedValue({task:detail,...draft} as never):action==="unrevert"?vi.spyOn(harness,"unrevertTask").mockResolvedValue(detail):vi.spyOn(harness,"promoteTask").mockResolvedValue({task,project:{id:"p",name:"P",rootPath:root,token:"PRIVATE"},warning:"元の削除失敗"} as never);
  const id=randomUUID(),body=action==="promote"?{destinationPath:"  "+root+"  ",entryId:"forged",fromBot:true}:action==="unrevert"?undefined:{entryId:" input ",destinationPath:"forged",botId:"forged"};
  const result=await request(action,body,id);expect(result.status).toBe(200);expect(result.body.operation).toEqual({id,execution:"complete"});expect(JSON.stringify(result.body).replace("PRIVATE-AUTHORED-DRAFT","")).not.toContain("PRIVATE");
  expect(op.mock.calls[0]).toEqual(action==="unrevert"?["t"]:["t",action==="promote"?root:"input"]);
  expect((await request(action,body,id)).status).toBe(409);expect(op).toHaveBeenCalledOnce();
  const ledger=readFileSync(join(root,"task-session-command.json"),"utf8");expect(ledger).not.toContain("PRIVATE");expect(ledger).not.toContain(root);expect(ledger).not.toContain("input");
 });
 it("auth/Origin/body limits reject before admission or SDK; invalid IDs/input reject owner-side",async()=>{
  const op=vi.spyOn(fork,"forkTask");const before=readdirSync(root);
  expect((await request("fork",{entryId:"u"},randomUUID(),false)).status).toBe(401);
  expect((await request("fork",{entryId:"u"},randomUUID(),true,"https://evil.test")).status).toBe(403);
  for(const action of ["fork","revert","unrevert","promote"])expect((await request(action,"x".repeat(4097))).status).toBe(413);
  expect(readdirSync(root)).toEqual(before);
  for(const value of [null,[],{},"{",{entryId:2},{entryId:" "},{entryId:"x".repeat(257)},{entryId:"bad\u0000id"}])expect((await request("fork",value)).status).toBe(400);
  for(const value of [null,[],{}, {destinationPath:42},{destinationPath:" "}])expect((await request("promote",value)).status).toBe(400);
  for(const taskId of ["..%2Fx","%252F"])expect((await request("fork",{entryId:"u"},randomUUID(),true,undefined,undefined,taskId)).status).toBe(400);
  expect(op).not.toHaveBeenCalled();
 });
 it("invalid SDK success and 5xx remain unknown; accepted disconnect is not cancellation or automatic replay",async()=>{
  const op=vi.spyOn(fork,"forkTask").mockResolvedValue({task:{},...draft} as never),malformed=randomUUID();
  const invalid=await request("fork",{entryId:"u"},malformed);expect(invalid.status).toBe(503);expect((invalid.body.operation as {execution:string}).execution).toBe("unknown");
  expect((await request("fork",{entryId:"u"},malformed)).status).toBe(409);
  op.mockRejectedValueOnce(new Error("PRIVATE filesystem failure"));const failed=await request("fork",{entryId:"u"});expect(failed.status).toBe(500);expect((failed.body.operation as {execution:string}).execution).toBe("unknown");expect(JSON.stringify(failed.body)).not.toContain("PRIVATE");
  let finish!:(v:never)=>void;op.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const controller=new AbortController(),id=randomUUID();
  const pending=request("fork",{entryId:"u"},id,true,undefined,controller.signal);await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));controller.abort();finish({task,...draft} as never);
  expect((await pending).status).toBe(200);expect((await request("fork",{entryId:"u"},id)).status).toBe(409);
 });
 it("concurrent admission allows control/refusal while another session operation is blocked",async()=>{
  let finish!:(v:never)=>void;const branching=vi.spyOn(fork,"forkTask").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  vi.spyOn(harness,"unrevertTask").mockRejectedValue(Object.assign(new Error("tree busy"),{status:409}));
  const pending=request("fork",{entryId:"u"});await vi.waitFor(()=>expect(branching).toHaveBeenCalledOnce());
  expect((await request("unrevert")).status).toBe(409);finish({task,...draft} as never);expect((await pending).status).toBe(200);
 });
 it("runtime entrances and dispatch reject Next before SDK, caches, filesystem or session effects",async()=>{
  const operations=[vi.spyOn(fork,"forkTask"),vi.spyOn(harness,"revertTask"),vi.spyOn(harness,"unrevertTask"),vi.spyOn(harness,"promoteTask")];const before=readdirSync(root);vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
  for(const call of [()=>entrances.forkTask("t","u"),()=>entrances.revertTask("t","u"),()=>entrances.unrevertTask("t"),()=>entrances.promoteTask("t",root)])expect(call).toThrow("owned by Backend");
  await expect(request("fork",{entryId:"u"})).rejects.toThrow("owned by Backend");expect(readdirSync(root)).toEqual(before);for(const op of operations)expect(op).not.toHaveBeenCalled();
 });
});

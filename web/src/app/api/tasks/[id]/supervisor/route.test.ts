import { BackendTestRequest as Request } from "@/test-request";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@backend-runtime/json-business/handlers/tasks/[id]/supervisor/route";
const mocks=vi.hoisted(()=>({handoffTaskToBot:vi.fn(),releaseTaskFromBot:vi.fn(),jsonError:(error:any)=>({error:error.message,status:error.status??500})}));
vi.mock("@/lib/pi/harness",()=>mocks);
beforeEach(()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");mocks.handoffTaskToBot.mockReset();mocks.releaseTaskFromBot.mockReset();});
afterEach(()=>vi.unstubAllEnvs());
const post=(body:unknown)=>POST(new Request("http://localhost/api/tasks/task-1/supervisor",{method:"POST",body:JSON.stringify(body)}),{params:Promise.resolve({id:"task-1"})});
describe("Backend Task supervisor",()=>{
 it("hands the trimmed selected Bot/task to SDK without caller control flags",async()=>{
  const task={id:"task-1",status:"working",supervisorBotId:"bot-1"};mocks.handoffTaskToBot.mockResolvedValue(task);
  expect(await (await post({botId:" bot-1 ",fromBot:true,approved:true})).json()).toEqual({task});
  expect(mocks.handoffTaskToBot).toHaveBeenCalledExactlyOnceWith("bot-1","task-1");
 });
 it("null returns ownership to user and never hands off or stops the Task",async()=>{
  const task={id:"task-1",supervisorBotId:null};mocks.releaseTaskFromBot.mockResolvedValue(task);
  expect(await (await post({botId:null,action:"abort"})).json()).toEqual({task});
  expect(mocks.releaseTaskFromBot).toHaveBeenCalledExactlyOnceWith("task-1");expect(mocks.handoffTaskToBot).not.toHaveBeenCalled();
 });
 it("bad body/Bot ID rejects before owner effects",async()=>{
  for(const body of [null,[],{},2,{botId:2},{botId:" "},{botId:"../escape"},{botId:"x".repeat(129)}])expect((await post(body)).status).toBe(400);
  expect(mocks.handoffTaskToBot).not.toHaveBeenCalled();expect(mocks.releaseTaskFromBot).not.toHaveBeenCalled();
 });
 it("SDK refusals retain status and private 5xx errors are sanitized",async()=>{
  for(const status of [403,404,409,500]){mocks.handoffTaskToBot.mockRejectedValueOnce(Object.assign(new Error("PRIVATE refusal"),{status}));const result=await post({botId:"one"});expect(result.status).toBe(status);if(status===500)expect(JSON.stringify(await result.json())).not.toContain("PRIVATE");}
 });
});

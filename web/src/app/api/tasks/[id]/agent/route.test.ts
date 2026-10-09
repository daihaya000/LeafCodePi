import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@backend-runtime/json-business/handlers/tasks/[id]/agent/route";
const mocks=vi.hoisted(()=>({select:vi.fn(),jsonError:vi.fn((error:unknown)=>({error:error instanceof Error?error.message:String(error),status:typeof error==="object"&&error&&"status" in error?Number(error.status):500}))}));
vi.mock("@backend-runtime/lib/task-execution-settings",()=>({setTaskAgent:mocks.select}));
vi.mock("@/lib/pi/harness",()=>({jsonError:mocks.jsonError}));
const context={params:Promise.resolve({id:"task-1"})};
const request=(body:unknown)=>new NextRequest("http://localhost/api/tasks/task-1/agent",{method:"POST",body:JSON.stringify(body)});
describe("owner agent handler",()=>{
 beforeEach(()=>{mocks.select.mockReset().mockResolvedValue({id:"task-1",status:"idle"});});
 it("delegates the selected value to the guarded owner",async()=>{const response=await POST(request({agent:"reviewer"}),context);expect(response.status).toBe(200);expect(mocks.select).toHaveBeenCalledWith("task-1","reviewer");expect(await response.json()).toEqual({task:{id:"task-1",status:"idle"}});});
 it("rejects malformed input before owner entry",async()=>{for(const body of [{},{agent:null},{agent:123}])expect((await POST(request(body),context)).status).toBe(400);expect(mocks.select).not.toHaveBeenCalled();});
 it("preserves owner refusal status without any fallback",async()=>{mocks.select.mockRejectedValue(Object.assign(new Error("safe refusal"),{status:409}));const response=await POST(request({agent:"reviewer"}),context);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"safe refusal"});expect(mocks.select).toHaveBeenCalledTimes(1);});
 it("allows clearing the selected agent",async()=>{expect((await POST(request({agent:""}),context)).status).toBe(200);expect(mocks.select).toHaveBeenCalledWith("task-1","");});
});

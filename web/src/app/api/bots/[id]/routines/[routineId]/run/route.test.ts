import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({ensureRoutineScheduler:vi.fn(),getRoutine:vi.fn(),runRoutine:vi.fn()}));
vi.mock("@/lib/routines",()=>mocks);
vi.mock("@/lib/pi/harness",()=>({jsonError:(error:Error&{status?:number})=>({error:error.message,status:error.status??500})}));
import { POST } from "@backend-runtime/json-business/handlers/bots/[id]/routines/[routineId]/run/route";
const context={params:Promise.resolve({id:"bot",routineId:"routine"})};
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");mocks.getRoutine.mockReturnValue({id:"routine",name:"authored"});mocks.runRoutine.mockResolvedValue({id:"routine",lastRunAt:"fixture"});});
describe("routine manual owner handler",()=>{
 it("runs only the owner selector, not caller commands",async()=>{const response=await POST(new Request("http://localhost",{method:"POST",body:'{"taskId":"forged"}'}),context);expect(response.status).toBe(200);expect(mocks.runRoutine).toHaveBeenCalledExactlyOnceWith("bot","routine");});
 it("preserves a scoped snapshot and sanitizes failed run errors",async()=>{mocks.runRoutine.mockRejectedValueOnce(new Error("PRIVATE SDK/path"));const response=await POST(new Request("http://localhost",{method:"POST"}),context);expect(response.status).toBe(500);expect(await response.json()).toEqual({error:"Bot routineの処理結果を確認できません",routine:{id:"routine",name:"authored"}});});
 it("rejects missing routines and Next before scheduler/SDK",async()=>{mocks.getRoutine.mockReturnValueOnce(undefined);expect((await POST(new Request("http://localhost",{method:"POST"}),context)).status).toBe(404);expect(mocks.runRoutine).not.toHaveBeenCalled();mocks.ensureRoutineScheduler.mockClear();vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(POST(new Request("http://localhost",{method:"POST"}),context)).rejects.toThrow("owned by Backend");expect(mocks.ensureRoutineScheduler).not.toHaveBeenCalled();});
});

import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({botIdForCodeTask:vi.fn(),abortTaskIncludingColdGoalLoop:vi.fn(),stopBotCodeTask:vi.fn()}));
vi.mock("@/lib/pi/bot-code-relay",()=>({botIdForCodeTask:mocks.botIdForCodeTask}));
vi.mock("@/lib/pi/harness",()=>({...mocks,jsonError:(e:unknown)=>({error:e instanceof Error?e.message:String(e),status:typeof e==="object"&&e!==null&&"status" in e?Number(e.status):500})}));
import { POST } from "@backend-runtime/json-business/handlers/tasks/[id]/abort/route";
const params={params:Promise.resolve({id:"code-1"})};
const request=()=>new Request("http://localhost/api/tasks/code-1/abort",{method:"POST",body:JSON.stringify({botId:"attacker"})});
beforeEach(()=>{vi.clearAllMocks();mocks.botIdForCodeTask.mockReturnValue(undefined);mocks.abortTaskIncludingColdGoalLoop.mockResolvedValue({id:"code-1",status:"idle"});mocks.stopBotCodeTask.mockResolvedValue({id:"code-1",status:"idle",botId:"owner-bot"});});
describe("Backend abort owner",()=>{
 it("stops ordinary Code including a cold Goal Loop",async()=>{expect((await POST(request(),params)).status).toBe(200);expect(mocks.abortTaskIncludingColdGoalLoop).toHaveBeenCalledWith("code-1");expect(mocks.stopBotCodeTask).not.toHaveBeenCalled();});
 it("resolves Bot supervision locally and ignores a caller-supplied Bot ID",async()=>{mocks.botIdForCodeTask.mockReturnValue("owner-bot");expect((await POST(request(),params)).status).toBe(200);expect(mocks.stopBotCodeTask).toHaveBeenCalledWith("owner-bot","code-1");expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();});
 it("returns 404 for missing or archived tasks with no fake successful stop",async()=>{mocks.abortTaskIncludingColdGoalLoop.mockResolvedValue(null);expect((await POST(request(),params)).status).toBe(404);});
 it("retains an owner stop refusal",async()=>{mocks.stopBotCodeTask.mockRejectedValue(Object.assign(new Error("stop failed"),{status:409}));mocks.botIdForCodeTask.mockReturnValue("owner-bot");expect((await POST(request(),params)).status).toBe(409);});
});

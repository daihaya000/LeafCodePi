import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import { POST } from "@backend-runtime/json-business/handlers/bots/[id]/abort/route";
const mocks=vi.hoisted(()=>({getBot:vi.fn(),stopBotCodeTask:vi.fn(),jsonError:(e:any)=>({error:e.message,status:e.status??500})}));
vi.mock("@/lib/bots",()=>({getBot:mocks.getBot,botTaskId:(id:string)=>`bot:${id}`}));
vi.mock("@/lib/pi/harness",()=>({stopBotCodeTask:mocks.stopBotCodeTask,jsonError:mocks.jsonError}));
beforeEach(()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");mocks.getBot.mockReset().mockReturnValue({id:"one"});mocks.stopBotCodeTask.mockReset().mockResolvedValue({id:"bot:one",status:"idle"});});
afterEach(()=>vi.unstubAllEnvs());
const post=()=>POST(new Request("http://localhost/api/bots/one/abort",{method:"POST",body:'{"botId":"forged","taskId":"other","action":"delete"}'}),{params:Promise.resolve({id:"one"})});
describe("Backend Bot abort",()=>{
 it("uses only the owner Bot-origin stop including matching outbox and cold Goal",async()=>{expect(await(await post()).json()).toEqual({task:{id:"bot:one",status:"idle"}});expect(mocks.stopBotCodeTask).toHaveBeenCalledExactlyOnceWith("one","bot:one");});
 it("missing Bot/task refuses before unrelated effects",async()=>{mocks.getBot.mockReturnValueOnce(undefined);expect((await post()).status).toBe(404);expect(mocks.stopBotCodeTask).not.toHaveBeenCalled();mocks.stopBotCodeTask.mockResolvedValueOnce(null);expect((await post()).status).toBe(404);});
 it("SDK status is retained but private 5xx is sanitized",async()=>{for(const status of [404,409,500]){mocks.stopBotCodeTask.mockRejectedValueOnce(Object.assign(new Error("PRIVATE"),{status}));const result=await post();expect(result.status).toBe(status);if(status>=500)expect(JSON.stringify(await result.json())).not.toContain("PRIVATE");}});
});

import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import { POST } from "@backend-runtime/json-business/handlers/bots/[id]/revert/route";
const mocks=vi.hoisted(()=>({getBot:vi.fn(),revertTask:vi.fn(),cancelBotCodeRequests:vi.fn(),jsonError:(e:any)=>({error:e.message,status:e.status??500})}));
vi.mock("@/lib/bots",()=>({getBot:mocks.getBot,botTaskId:(id:string)=>`bot:${id}`}));
vi.mock("@/lib/pi/harness",()=>({revertTask:mocks.revertTask,jsonError:mocks.jsonError}));
vi.mock("@/lib/pi/bot-code-relay",()=>({cancelBotCodeRequests:mocks.cancelBotCodeRequests}));
beforeEach(()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");mocks.getBot.mockReset().mockReturnValue({id:"one"});mocks.revertTask.mockReset().mockResolvedValue({task:{id:"bot:one"},text:"戻した",images:[],files:[]});mocks.cancelBotCodeRequests.mockReset().mockResolvedValue(2);});
afterEach(()=>vi.unstubAllEnvs());
const post=(body:unknown={entryId:" entry-1 ",botId:"forged"})=>POST(new Request("http://localhost/api/bots/one/revert",{method:"POST",body:JSON.stringify(body)}),{params:Promise.resolve({id:"one"})});
describe("Backend Bot rewind",()=>{
 it("rewinds before cancelling only that Bot's discarded 1:1-origin Code jobs",async()=>{expect(await(await post()).json()).toMatchObject({text:"戻した",cancelledCodeRequests:2});expect(mocks.revertTask).toHaveBeenCalledExactlyOnceWith("bot:one","entry-1");expect(mocks.cancelBotCodeRequests).toHaveBeenCalledExactlyOnceWith("one");expect(mocks.revertTask.mock.invocationCallOrder[0]).toBeLessThan(mocks.cancelBotCodeRequests.mock.invocationCallOrder[0]);});
 it("invalid entries/missing Bot cause no tree/outbox effects",async()=>{for(const body of [null,[],{},2,{entryId:" "},{entryId:"x".repeat(257)},{entryId:"bad\u0000id"}])expect((await post(body)).status).toBe(400);mocks.getBot.mockReturnValueOnce(undefined);expect((await post()).status).toBe(404);expect(mocks.revertTask).not.toHaveBeenCalled();expect(mocks.cancelBotCodeRequests).not.toHaveBeenCalled();});
 it("refused edits do not cancel Code; post-edit outbox failure is unknown/private",async()=>{mocks.revertTask.mockRejectedValueOnce(Object.assign(new Error("busy"),{status:409}));expect((await post()).status).toBe(409);expect(mocks.cancelBotCodeRequests).not.toHaveBeenCalled();mocks.cancelBotCodeRequests.mockRejectedValueOnce(new Error("PRIVATE path"));const result=await post();expect(result.status).toBe(503);expect(JSON.stringify(await result.json())).not.toContain("PRIVATE");});
});

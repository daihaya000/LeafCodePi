import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@backend-runtime/json-business/handlers/tasks/[id]/search/route";
import { resetTaskTranscriptCache } from "@/lib/task-transcript";
const mocks=vi.hoisted(()=>({getTaskDetailBounded:vi.fn(),jsonError:vi.fn((error:unknown)=>({error:error instanceof Error?error.message:String(error),status:typeof error==="object"&&error&&"status" in error?Number(error.status):500}))}));
vi.mock("@backend-runtime/lib/pi/get-task-detail-bounded",()=>({getTaskDetailBounded:mocks.getTaskDetailBounded}));
vi.mock("@/lib/pi/harness",()=>({jsonError:mocks.jsonError}));
const message=(id:string,text:string,extra:Record<string,unknown>={})=>({id,role:"user",createdAt:1,parts:[{id:`${id}:text`,type:"text",text}],...extra});
const context={params:Promise.resolve({id:"task-1"})};const request=(query:string)=>new NextRequest(`http://localhost/api/tasks/task-1/search${query}`);
describe("owner whole-transcript search",()=>{
 beforeEach(()=>{mocks.getTaskDetailBounded.mockReset();resetTaskTranscriptCache();});
 it("shares bounded read-only reads for refinements and retries failed reads only on a new request",async()=>{mocks.getTaskDetailBounded.mockRejectedValueOnce(Object.assign(new Error("busy"),{status:503}));expect((await GET(request("?q=needle"),context)).status).toBe(503);mocks.getTaskDetailBounded.mockResolvedValue({messages:[message("u1","needle haystack")]});for(const query of ["need","needle","hay"]){expect((await(await GET(request(`?q=${query}`),context)).json()).total).toBe(1);}expect(mocks.getTaskDetailBounded).toHaveBeenCalledTimes(2);expect(mocks.getTaskDetailBounded).toHaveBeenLastCalledWith("task-1",{readOnly:true});});
 it("preserves Japanese snippet highlights",async()=>{mocks.getTaskDetailBounded.mockResolvedValue({messages:[message("u1","エラーの原因は tokenの期限切れ です")]});const body=await(await GET(request("?q="+encodeURIComponent("エラー")),context)).json();expect(body.total).toBe(1);const hit=body.hits[0];expect(hit.snippet.slice(...hit.highlights[0])).toBe("エラー");});
 it("excludes hidden retries/unpersisted/tool-only content and caps to newest hits",async()=>{mocks.getTaskDetailBounded.mockResolvedValue({messages:[message("r1","needle",{hangRetry:true}),message("msg-1","needle"),message("tool","",{parts:[{type:"tool",output:"needle"}]}),...Array.from({length:6},(_,i)=>message(`m${i}`,`needle ${i}`))]});const body=await(await GET(request("?q=needle&limit=2"),context)).json();expect(body).toMatchObject({total:6,truncated:true});expect(body.hits.map((h:{messageId:string})=>h.messageId)).toEqual(["m4","m5"]);});
 it("rejects empty/oversized queries before reads and preserves missing-task errors",async()=>{for(const query of ["","?q=%20","?q="+"a".repeat(401)])expect((await GET(request(query),context)).status).toBe(400);expect(mocks.getTaskDetailBounded).not.toHaveBeenCalled();mocks.getTaskDetailBounded.mockRejectedValue(Object.assign(new Error("missing"),{status:404}));expect((await GET(request("?q=x"),context)).status).toBe(404);});
});

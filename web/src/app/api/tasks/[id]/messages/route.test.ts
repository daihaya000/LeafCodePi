import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@backend-runtime/json-business/handlers/tasks/[id]/messages/route";
import { pageTaskMessages } from "@shared/task-history.mjs";
const mocks=vi.hoisted(()=>({readTaskTranscript:vi.fn(),readTaskTranscriptPage:vi.fn(),readHistoryPageSize:vi.fn(()=>50)}));
vi.mock("@/lib/task-transcript",()=>({readTaskTranscriptPage:mocks.readTaskTranscriptPage}));
vi.mock("@backend-runtime/lib/pi/history-page-size",()=>({readHistoryPageSize:mocks.readHistoryPageSize}));
const message=(id:string,index=0)=>({id,role:"user",createdAt:index,parts:[{id:`${id}:text`,type:"text",text:id},{id:`${id}:image`,type:"image",mime:"image/png",url:"data:image/png;base64,AAAA"}]});
const context={params:Promise.resolve({id:"task-1"})};
describe("owner history paging",()=>{
 beforeEach(()=>{mocks.readTaskTranscript.mockReset();mocks.readHistoryPageSize.mockReturnValue(50);mocks.readTaskTranscriptPage.mockReset().mockImplementation(async(id,before,limit)=>{const read=await mocks.readTaskTranscript(id);return read.ok?pageTaskMessages(read.messages,before,limit):read;});});
 it("uses configured size and stable before cursors",async()=>{const messages=Array.from({length:120},(_,i)=>message(`m${i}`,i));mocks.readTaskTranscript.mockResolvedValue({ok:true,messages});mocks.readHistoryPageSize.mockReturnValue(100);const body=await(await GET(new Request("http://localhost/api/tasks/task-1/messages"),context)).json();expect(body.messages).toHaveLength(100);expect(body.messageHistory).toEqual({hasMore:true,nextCursor:"m20"});expect(body.messages[0].parts[1].url).toContain("data:");const old=await(await GET(new Request("http://localhost/api/tasks/task-1/messages?before=m100"),context)).json();expect(old.messages.at(-1).id).toBe("m99");expect(old.messages[0].parts[1]).toMatchObject({url:"",filename:"m0:image.png"});expect(mocks.readTaskTranscriptPage).toHaveBeenCalledWith("task-1","m100",100,expect.any(AbortSignal));});
 it("rejects malformed cursor before reads and stale cursors as conflict",async()=>{expect((await GET(new Request("http://localhost/api/tasks/task-1/messages?before=%20"),context)).status).toBe(400);expect(mocks.readTaskTranscript).not.toHaveBeenCalled();mocks.readTaskTranscript.mockResolvedValue({ok:true,messages:[message("m1")]});expect((await GET(new Request("http://localhost/api/tasks/task-1/messages?before=missing"),context)).status).toBe(409);});
 it("preserves missing/unavailable statuses without fallback",async()=>{for(const status of [404,503]){mocks.readTaskTranscript.mockResolvedValueOnce({ok:false,status,body:{error:"unavailable"}});expect((await GET(new Request("http://localhost/api/tasks/task-1/messages"),context)).status).toBe(status);}});
});

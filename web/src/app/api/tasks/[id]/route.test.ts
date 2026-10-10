import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getTaskDetailBounded:vi.fn(), archiveTask:vi.fn(), destroyTask:vi.fn(), restoreTask:vi.fn() }));
vi.mock("@backend-runtime/lib/pi/get-task-detail-bounded",()=>({getTaskDetailBounded:mocks.getTaskDetailBounded}));
vi.mock("@backend-runtime/lib/pi/history-page-size",()=>({readHistoryPageSize:()=>200}));
vi.mock("@/lib/pi/harness",()=>({...mocks,jsonError:(e:unknown)=>({error:e instanceof Error?e.message:String(e),status:typeof e==="object"&&e!==null&&"status" in e?Number(e.status):500})}));
import { GET, PATCH, DELETE } from "@backend-runtime/json-business/handlers/tasks/[id]/route";
const params={params:Promise.resolve({id:"task-1"})};
const request=(method="GET",query="",body?:unknown)=>new Request(`http://localhost/api/tasks/task-1${query}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
beforeEach(()=>{vi.clearAllMocks();mocks.getTaskDetailBounded.mockResolvedValue({id:"task-1",status:"idle",isStreaming:false,messages:[]});mocks.archiveTask.mockResolvedValue({id:"task-1",status:"archived"});mocks.destroyTask.mockResolvedValue({ok:true});mocks.restoreTask.mockReturnValue({id:"task-1",status:"idle"});});
describe("Backend individual Task owner",()=>{
  it("reads bounded detail and retains conditional ETag",async()=>{const first=await GET(request(),params);expect(first.status).toBe(200);expect(mocks.getTaskDetailBounded).toHaveBeenCalledWith("task-1",{readOnly:true});const etag=first.headers.get("etag")!;const next=await GET(new Request("http://localhost/api/tasks/task-1",{headers:{"if-none-match":etag}}),params);expect(next.status).toBe(304);expect(await next.text()).toBe("");});
  it("pages at the owner's configured size",async()=>{mocks.getTaskDetailBounded.mockResolvedValue({id:"task-1",messages:Array.from({length:250},(_,i)=>({id:`m${i}`,role:"user",parts:[]}))});const body=await(await GET(request("GET","?messages=page"),params)).json();expect(body.task.messages).toHaveLength(200);expect(body.task.messageHistory).toEqual({hasMore:true,nextCursor:"m50"});});
  it("omit passes the hydration option and removes even an archived reader's returned messages",async()=>{mocks.getTaskDetailBounded.mockResolvedValue({id:"task-1",status:"archived",messages:[{id:"old"}]});const body=await(await GET(request("GET","?messages=omit"),params)).json();expect(body.task.messages).toEqual([]);expect(mocks.getTaskDetailBounded).toHaveBeenCalledWith("task-1",{readOnly:true,includeMessages:false});});
  it("unknown messages mode remains a full bounded read",async()=>{await GET(request("GET","?messages=bogus"),params);expect(mocks.getTaskDetailBounded).toHaveBeenCalledWith("task-1",{readOnly:true});});
  it.each([404,409,503])("preserves owner refusal %s",async status=>{mocks.getTaskDetailBounded.mockRejectedValueOnce(Object.assign(new Error("owner refusal"),{status}));expect((await GET(request(),params)).status).toBe(status);});
  it("restores only archived=false, otherwise rejects the patch",async()=>{expect((await PATCH(request("PATCH","",{archived:true}),params)).status).toBe(400);expect(mocks.restoreTask).not.toHaveBeenCalled();expect((await PATCH(request("PATCH","",{archived:false}),params)).status).toBe(200);expect(mocks.restoreTask).toHaveBeenCalledWith("task-1");});
  it("archives or hard deletes after owner teardown",async()=>{expect((await(await DELETE(request("DELETE"),params)).json()).task.status).toBe("archived");expect((await(await DELETE(request("DELETE","?hard=1"),params)).json()).ok).toBe(true);expect(mocks.archiveTask).toHaveBeenCalledWith("task-1");expect(mocks.destroyTask).toHaveBeenCalledWith("task-1");});
});

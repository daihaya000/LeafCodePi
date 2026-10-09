import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayJsonBusiness } from "./json-business-relay";
import { NextRequest } from "next/server";
import { POST as saveAccountKey } from "../app/api/accounts/[id]/openrouter-credits/route";
import { POST as consumeResetCredit } from "../app/api/codexbar/reset-credits/route";
import { POST as resolvePeer } from "../app/api/peer-auth/resolve/route";
import { GET as peerImports } from "../app/api/peer-auth/import/route";
import { GET as workspaceFiles } from "../app/api/projects/[id]/files/route";
import { PATCH as patchProject, GET as listProjects } from "../app/api/projects/route";
import { POST as createCollectionTask, GET as collectionTasks, DELETE as clearArchivedTasks } from "../app/api/tasks/route";
import { TASK_COLLECTION_BODY_LIMIT } from "@shared/task-collection-contract.mjs";
import { GET as taskDetail, PATCH as restoreIndividualTask, DELETE as teardownIndividualTask } from "../app/api/tasks/[id]/route";
import { POST as abortIndividualTask } from "../app/api/tasks/[id]/abort/route";
import { GET as historyPage } from "../app/api/tasks/[id]/messages/route";
import { GET as historySearch } from "../app/api/tasks/[id]/search/route";
import { GET as bookmarks, PUT as addBookmark, DELETE as removeBookmark } from "../app/api/tasks/[id]/bookmarks/route";
import { TASK_HISTORY_BODY_LIMIT } from "@shared/task-history-contract.mjs";
import { POST as selectTaskModel } from "../app/api/tasks/[id]/model/route";
import { POST as selectTaskThinking } from "../app/api/tasks/[id]/thinking/route";
import { POST as selectTaskAgent } from "../app/api/tasks/[id]/agent/route";
import { PUT as selectGoalAuto } from "../app/api/tasks/[id]/goal-loop-auto-model/route";
import { GET as readTaskGoal, POST as startTaskGoal, PATCH as controlTaskGoal } from "../app/api/tasks/[id]/goal-loop/route";
import { GET as activeTaskGoals } from "../app/api/goal-loop/active/route";
import { POST as compactSession } from "../app/api/tasks/[id]/compact/route";
import { POST as abortCompaction } from "../app/api/tasks/[id]/compact/abort/route";
import { TASK_COMPACTION_BODY_LIMIT } from "@shared/task-compaction-contract.mjs";
import { POST as forkSession } from "../app/api/tasks/[id]/fork/route";
import { POST as revertSession } from "../app/api/tasks/[id]/revert/route";
import { POST as unrevertSession } from "../app/api/tasks/[id]/unrevert/route";
import { POST as promoteSession } from "../app/api/tasks/[id]/promote/route";
import { POST as sendPrompt } from "../app/api/tasks/[id]/prompt/route";
import { POST as answerPermission } from "../app/api/tasks/[id]/permission/route";
import { POST as answerQuestion } from "../app/api/tasks/[id]/question/route";
import * as dirtyHub from "./backend-task-dirty-hub";
import { POST as nextTask } from "../app/api/projects/[id]/next-task/route";
let root: string;
const fetcher = vi.fn();
const request = (route = "git/init", body = '{"directory":"repo"}') => new Request(`http://localhost/api/${route}`, { method: "POST", body });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-json-ingress-"));
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_WEBUI_AUTH: "",
    LEAFCODE_PI_WEBUI_TOKEN: "", LEAFCODE_PI_BACKEND_TOKEN: "owner-private-token-1234567890123456789", LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "" })) vi.stubEnv(key, value);
  fetcher.mockReset().mockImplementation(async () => Response.json({ status: 200, body: { ok: true, directory: "repo", token: "PRIVATE" }, headers: { "set-cookie": "PRIVATE" } }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("JSON business ingress", () => {
  it("actual compaction start/abort relay opaque focus, preserve cancellation state and require matching ACK",async()=>{
    const context={params:Promise.resolve({id:"bot:fixture"})},task={id:"bot:fixture",status:"idle",isStreaming:false,isCompacting:true,messages:[],token:"PRIVATE"};
    for(const [action,handler] of [["compact",compactSession],["compact/abort",abortCompaction]] as const){
      const body='{"customInstructions":"日本語","model":"forged","unknownField":42}';
      fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:200,body:{task,operation:{id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"complete"},token:"PRIVATE"}}));
      const response=await handler(new NextRequest(`http://localhost/api/tasks/bot%3Afixture/${action}`,{method:"POST",body}),context);expect(response.status).toBe(200);
      const dto=await response.json();expect(dto.task.isCompacting).toBe(true);expect(JSON.stringify(dto)).not.toContain("PRIVATE");expect(new TextDecoder().decode(fetcher.mock.calls.at(-1)![1].body)).toBe(body);expect(fetcher.mock.calls.at(-1)![0]).toContain(`/tasks/bot%3Afixture/${action}`);
      for(const operation of [undefined,{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",execution:"complete"}]){
        fetcher.mockResolvedValueOnce(Response.json({status:200,body:{task,operation}}));const failed=await handler(new NextRequest(`http://localhost/api/tasks/t/${action}`,{method:"POST",body:"{}"}),context);expect(failed.status).toBe(503);expect((await failed.json()).execution).toBe("unknown");
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(6);expect(readdirSync(root)).toEqual([]);
  });
  it("compaction start supports escaped 32k focus, abort stays 4KiB, and auth/Origin precede forwarding",async()=>{
    const context={params:Promise.resolve({id:"t"})};
    expect((await compactSession(new NextRequest("http://localhost/api/tasks/t/compact",{method:"POST",body:"x".repeat(TASK_COMPACTION_BODY_LIMIT+1)}),context)).status).toBe(413);
    expect((await abortCompaction(new NextRequest("http://localhost/api/tasks/t/compact/abort",{method:"POST",body:"x".repeat(4097)}),context)).status).toBe(413);
    expect((await compactSession(new NextRequest("http://localhost/api/tasks/t/compact",{method:"POST",body:"{}",headers:{origin:"https://evil.test"}}),context)).status).toBe(403);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await abortCompaction(new NextRequest("http://localhost/api/tasks/t/compact/abort",{method:"POST",body:"{}"}),context)).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
  });
  it("session routes relay opaque bodies, require matching ACKs, retain draft/project warning and reject private fields",async()=>{
    const context={params:Promise.resolve({id:"bot:fixture"})},task={id:"bot:fixture",status:"idle",token:"PRIVATE"},detail={...task,isStreaming:false,messages:[]};
    for(const [action,handler] of [["fork",forkSession],["revert",revertSession],["unrevert",unrevertSession],["promote",promoteSession]] as const) {
      const body='{"entryId":"opaque","destinationPath":"opaque","invalidDomainInput":"日本語"}';
      fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:200,body:{task:action==="revert"||action==="unrevert"?detail:task,text:"authored",images:[{uri:"data:image/png;base64,YQ==",mime:"image/png",token:"PRIVATE"}],files:[],project:{id:"p",name:"P",rootPath:"path",token:"PRIVATE"},warning:"元の削除失敗",operation:{id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"complete"}}}));
      const response=await handler(new NextRequest(`http://localhost/api/tasks/bot%3Afixture/${action}`,{method:"POST",body}),context);expect(response.status).toBe(200);
      const dto=await response.json();expect(JSON.stringify(dto)).not.toContain("PRIVATE");if(action==="promote")expect(dto.warning).toBe("元の削除失敗");
      expect(new TextDecoder().decode(fetcher.mock.calls.at(-1)![1].body)).toBe(body);expect(fetcher.mock.calls.at(-1)![0]).toContain(`/tasks/bot%3Afixture/${action}`);
      for(const operation of [undefined,{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",execution:"complete"}]){
        fetcher.mockResolvedValueOnce(Response.json({status:200,body:{task:action==="revert"||action==="unrevert"?detail:task,text:"authored",images:[],files:[],project:{id:"p",name:"P",rootPath:"path"},operation}}));
        const failed=await handler(new NextRequest(`http://localhost/api/tasks/t/${action}`,{method:"POST",body:"{}"}),context);expect(failed.status).toBe(503);expect((await failed.json()).execution).toBe("unknown");
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(12);expect(readdirSync(root)).toEqual([]);
  });
  it("session auth, Origin and 4KiB bounds precede forwarding for all four operations",async()=>{
    const context={params:Promise.resolve({id:"t"})};
    for(const [action,handler] of [["fork",forkSession],["revert",revertSession],["unrevert",unrevertSession],["promote",promoteSession]] as const) {
      const url=`http://localhost/api/tasks/t/${action}`;
      expect((await handler(new NextRequest(url,{method:"POST",body:"x".repeat(4097)}),context)).status).toBe(413);
      expect((await handler(new NextRequest(url,{method:"POST",body:"{}",headers:{origin:"https://evil.test"}}),context)).status).toBe(403);
    }
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await forkSession(new NextRequest("http://localhost/api/tasks/t/fork",{method:"POST",body:"{}"}),context)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
  });
  it("actual Goal reads/control/start are opaque relays with deep DTO and matching command ACKs",async()=>{
    const context={params:Promise.resolve({id:"bot:fixture"})};
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{loop:null}}));
    expect(await(await readTaskGoal(new NextRequest("http://localhost/api/tasks/bot%3Afixture/goal-loop"),context)).json()).toEqual({loop:null});
    expect(new Headers(fetcher.mock.calls.at(-1)![1].headers).has("x-leafcode-business-operation")).toBe(false);
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{active:1,taskIds:["bot:fixture"],token:"PRIVATE"}}));
    expect(await(await activeTaskGoals(new NextRequest("http://localhost/api/goal-loop/active"))).json()).toEqual({active:1,taskIds:["bot:fixture"]});
    for(const [method,handler] of [["POST",startTaskGoal],["PATCH",controlTaskGoal]] as const){
      const body='{"opaque":"日本語","botId":"untrusted","invalidDomainInput":42}';
      fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:200,body:{loop:{id:"g",status:"queued",goal:"authored",progress:[{summary:"authored",token:"PRIVATE"}]},agent:null,operation:{id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"complete"},token:"PRIVATE"}}));
      const response=await handler(new NextRequest("http://localhost/api/tasks/bot%3Afixture/goal-loop",{method,body}),context);expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
      const [url,init]=fetcher.mock.calls.at(-1)!;expect(url).toContain("/tasks/bot%3Afixture/goal-loop");expect(new TextDecoder().decode(init.body)).toBe(body);
    }
    expect(readdirSync(root)).toEqual([]);
  });
  it("Goal control has a 4KiB budget while image-compatible start retains 18MiB; auth/Origin precede forwarding",async()=>{
    const context={params:Promise.resolve({id:"t"})},url="http://localhost/api/tasks/t/goal-loop";
    expect((await controlTaskGoal(new NextRequest(url,{method:"PATCH",body:"x".repeat(4097)}),context)).status).toBe(413);
    expect((await startTaskGoal(new NextRequest(url,{method:"POST",body:"{}",headers:{"content-length":String(18*1024*1024+1)}}),context)).status).toBe(413);
    expect((await controlTaskGoal(new NextRequest(url,{method:"PATCH",body:"{}",headers:{origin:"https://evil.test"}}),context)).status).toBe(403);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await readTaskGoal(new NextRequest(url),context)).status).toBe(401);expect((await activeTaskGoals(new NextRequest("http://localhost/api/goal-loop/active"))).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
  });
  it("Goal mutation missing/mismatched ACK or null/malformed success stays unknown, without replay or empty active fallback",async()=>{
    const context={params:Promise.resolve({id:"t"})};
    for(const body of [{loop:{status:"queued"}},{loop:{status:"queued"},operation:{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",execution:"complete"}}]){
      fetcher.mockResolvedValueOnce(Response.json({status:200,body}));const failed=await startTaskGoal(new NextRequest("http://localhost/api/tasks/t/goal-loop",{method:"POST",body:"{}"}),context);expect(failed.status).toBe(503);expect((await failed.json()).execution).toBe("unknown");
    }
    fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:200,body:{loop:null,operation:{id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"complete"}}}));
    expect((await controlTaskGoal(new NextRequest("http://localhost/api/tasks/t/goal-loop",{method:"PATCH",body:"{}"}),context)).status).toBe(503);
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{active:0,taskIds:["hidden"]}}));expect((await activeTaskGoals(new NextRequest("http://localhost/api/goal-loop/active"))).status).toBe(503);expect(fetcher).toHaveBeenCalledTimes(4);expect(readdirSync(root)).toEqual([]);
  });

  it("actual prompt/permission/question routes relay opaque input, scrub owner output and wake only accepted prompts",async()=>{
    const wake=vi.spyOn(dirtyHub,"wakeBackendTaskListeners"),context={params:Promise.resolve({id:"bot:fixture"})};
    for(const [suffix,handler] of [["prompt",sendPrompt],["permission",answerPermission],["question",answerQuestion]] as const){
      fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:200,body:{...(suffix==="prompt"?{task:{id:"bot:fixture",status:"working",token:"PRIVATE"},autoDecision:{providerID:"p",modelID:"m",escalation:{providerID:"p",modelID:"b",token:"PRIVATE"}}}:{ok:true}),operation:{id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"complete",token:"PRIVATE"},credentials:"PRIVATE"}}));
      const body='{"opaque":"日本語","fromBot":true,"invalidDomainInput":42}';
      const response=await handler(new NextRequest(`http://localhost/api/tasks/bot%3Afixture/${suffix}`,{method:"POST",body}),context);
      expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
      const [url,init]=fetcher.mock.calls.at(-1)!;expect(url).toContain(`/tasks/bot%3Afixture/${suffix}`);expect(new TextDecoder().decode(init.body)).toBe(body);
    }
    expect(wake).toHaveBeenCalledExactlyOnceWith("bot:fixture","prompt");expect(readdirSync(root)).toEqual([]);
  });
  it("conversation ACK loss, mismatch or owner uncertainty never retries or falls back",async()=>{
    const context={params:Promise.resolve({id:"t"})},wake=vi.spyOn(dirtyHub,"wakeBackendTaskListeners");
    for(const operation of [undefined,{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",execution:"complete"}]){
      fetcher.mockResolvedValueOnce(Response.json({status:200,body:{ok:true,operation}}));const lost=await answerPermission(new NextRequest("http://localhost/api/tasks/t/permission",{method:"POST",body:"{}"}),context);
      expect(lost.status).toBe(503);expect((await lost.json()).execution).toBe("unknown");
    }
    fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:503,body:{error:"Unknown accepted prompt",operation:{id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"unknown"}}}));
    const failed=await sendPrompt(new NextRequest("http://localhost/api/tasks/t/prompt",{method:"POST",body:"{}"}),context);expect(failed.status).toBe(503);expect((await failed.json()).operation.execution).toBe("unknown");expect(fetcher).toHaveBeenCalledTimes(3);expect(wake).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
  });
  it("conversation auth, Origin and byte bounds fail before forwarding; unauth input is not read",async()=>{
    const context={params:Promise.resolve({id:"t"})};
    for(const [suffix,limit,handler] of [["prompt",18*1024*1024,sendPrompt],["permission",4096,answerPermission],["question",16384,answerQuestion]] as const){
      const url=`http://localhost/api/tasks/t/${suffix}`;
      expect((await handler(new NextRequest(url,{method:"POST",body:"{}",headers:{"content-length":String(limit+1)}}),context)).status).toBe(413);
      expect((await handler(new NextRequest(url,{method:"POST",body:"{}",headers:{origin:"https://evil.test"}}),context)).status).toBe(403);
    }
    expect((await answerQuestion(new NextRequest("http://localhost/api/tasks/t/question",{method:"POST",body:'{"answers":[["'+"日".repeat(6000)+'"]]}'}),context)).status).toBe(413);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await sendPrompt(new NextRequest("http://localhost/api/tasks/t/prompt",{method:"POST",body:"{invalid"}),context)).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
  });

  it("actual task model/thinking/Agent/Auto routes relay opaque input and require matching Task ACKs without local writes",async()=>{
    const context={params:Promise.resolve({id:"bot:fixture"})};
    for(const [suffix,method,handler,body] of [["model","POST",selectTaskModel,{model:"pin::p::m"}],["thinking","POST",selectTaskThinking,{thinkingLevel:"high"}],["agent","POST",selectTaskAgent,{agent:""}],["goal-loop-auto-model","PUT",selectGoalAuto,{enabled:true}]] as const){
      fetcher.mockImplementationOnce(async(_url,options)=>Response.json({status:200,body:{...(suffix==="goal-loop-auto-model"?{enabled:true}:{task:{id:"bot:fixture",status:"working",accountId:"pin",accountIdExplicit:true,agent:null,credentials:"PRIVATE"}}),operation:{id:new Headers(options.headers).get("x-leafcode-business-operation"),execution:"complete"}}}));
      const input=JSON.stringify(body);const response=await handler(new NextRequest("http://localhost/api/tasks/bot%3Afixture/"+suffix,{method,body:input}),context);expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");const call=fetcher.mock.calls.at(-1)!;expect(call[0]).toContain("/tasks/bot%3Afixture/"+suffix);expect(new TextDecoder().decode(call[1].body)).toBe(input);
    }
    expect(readdirSync(root)).toEqual([]);expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{enabled:true}}));const lost=await selectGoalAuto(new NextRequest("http://localhost/api/tasks/bot%3Afixture/goal-loop-auto-model",{method:"PUT",body:'{"enabled":true}'}),context);expect((await lost.json()).execution).toBe("unknown");expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("task execution setting body/auth/Origin refuse before Backend contact",async()=>{
    const context={params:Promise.resolve({id:"t"})};
    expect((await selectTaskModel(new NextRequest("http://localhost/api/tasks/t/model",{method:"POST",body:"x".repeat(4097)}),context)).status).toBe(413);
    expect((await selectGoalAuto(new NextRequest("http://localhost/api/tasks/t/goal-loop-auto-model",{method:"PUT",body:"{}",headers:{origin:"https://evil.test"}}),context)).status).toBe(403);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await selectTaskAgent(new NextRequest("http://localhost/api/tasks/t/agent",{method:"POST",body:"{}"}),context)).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual([]);
  });
  it("actual history/search/bookmark routes relay query/encoded IDs and strip nested private data without local work",async()=>{
    const context={params:Promise.resolve({id:"bot:fixture"})};
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{messages:[{id:"u",role:"user",createdAt:1,parts:[{id:"p",type:"text",text:"authored",token:"PRIVATE"}],session:"PRIVATE"}],messageHistory:{hasMore:false,nextCursor:null},token:"PRIVATE"}}));
    const page=await historyPage(new NextRequest("http://localhost/api/tasks/bot%3Afixture/messages?before=u1"),context);expect(page.status).toBe(200);expect(JSON.stringify(await page.json())).not.toContain("PRIVATE");expect(fetcher.mock.calls[0][0]).toContain("/tasks/bot%3Afixture/messages?before=u1");
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{terms:["x"],total:1,truncated:false,hits:[{messageId:"u",role:"user",createdAt:1,snippet:"x",highlights:[[0,1]],count:1,token:"PRIVATE"}]}}));
    expect((await historySearch(new NextRequest("http://localhost/api/tasks/bot%3Afixture/search?q=x&limit=2"),context)).status).toBe(200);expect(fetcher.mock.calls[1][0]).toContain("?q=x&limit=2");
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{bookmarks:[],missing:[]}}));expect((await bookmarks(new NextRequest("http://localhost/api/tasks/bot%3Afixture/bookmarks?verify=1"),context)).status).toBe(200);expect(readdirSync(root)).toEqual([]);
  });
  it("bookmark writes require matching ACKs, auth/Origin and bounded transport, without retry/fallback",async()=>{
    const context={params:Promise.resolve({id:"t"})};
    fetcher.mockImplementationOnce(async(_url,options)=>Response.json({status:200,body:{bookmarks:[],operation:{id:new Headers(options.headers).get("x-leafcode-business-operation"),execution:"complete"}}}));
    expect((await addBookmark(new NextRequest("http://localhost/api/tasks/t/bookmarks",{method:"PUT",body:'{"messageId":"u","role":"user"}'}),context)).status).toBe(200);
    fetcher.mockResolvedValueOnce(Response.json({status:200,body:{bookmarks:[]}}));const lost=await removeBookmark(new NextRequest("http://localhost/api/tasks/t/bookmarks?messageId=u",{method:"DELETE"}),context);expect((await lost.json()).execution).toBe("unknown");expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await addBookmark(new NextRequest("http://localhost/api/tasks/t/bookmarks",{method:"PUT",body:"x".repeat(TASK_HISTORY_BODY_LIMIT+1)}),context)).status).toBe(413);
    expect((await addBookmark(new NextRequest("http://localhost/api/tasks/t/bookmarks",{method:"PUT",body:"{}",headers:{origin:"https://evil.test"}}),context)).status).toBe(403);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await bookmarks(new NextRequest("http://localhost/api/tasks/t/bookmarks"),context)).status).toBe(401);expect(fetcher).toHaveBeenCalledTimes(2);expect(readdirSync(root)).toEqual([]);
  });
  it("individual task detail relays modes, projects rich DTOs and retains 304 without local reads", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { task: { id: "bot:fixture", status: "idle", isStreaming: false, messages: [], permissionRequest: { id: "p", command: "inspect", token: "PRIVATE" }, session: { token: "PRIVATE" } } } }));
    const context = { params: Promise.resolve({ id: "bot:fixture" }) };
    const response = await taskDetail(new NextRequest("http://localhost/api/tasks/bot%3Afixture?messages=omit"), context);
    expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE"); expect(fetcher.mock.calls[0][0]).toContain("/tasks/bot%3Afixture?messages=omit"); expect(new Headers(fetcher.mock.calls[0][1].headers).has("x-leafcode-business-operation")).toBe(false);
    fetcher.mockResolvedValueOnce(Response.json({ status: 304, headers: { etag: "e" }, body: null })); expect((await taskDetail(new NextRequest("http://localhost/api/tasks/bot%3Afixture?messages=page"), context)).status).toBe(304); expect(readdirSync(root)).toEqual([]);
  });
  it("restore/archive/hard-delete/abort require matching operation ACKs and do not select Bot ownership in Next", async () => {
    const context = { params: Promise.resolve({ id: "t" }) };
    fetcher.mockImplementation(async (_url, options) => Response.json({ status: 200, body: { ok: true, operation: { id: new Headers(options.headers).get("x-leafcode-business-operation"), execution: "complete" } } }));
    expect((await restoreIndividualTask(new NextRequest("http://localhost/api/tasks/t", { method: "PATCH", body: '{"archived":false}' }), context)).status).toBe(200);
    expect((await teardownIndividualTask(new NextRequest("http://localhost/api/tasks/t?hard=1", { method: "DELETE" }), context)).status).toBe(200);
    expect((await abortIndividualTask(new NextRequest("http://localhost/api/tasks/t/abort", { method: "POST", body: '{"botId":"untrusted"}' }), context)).status).toBe(200); expect(fetcher.mock.calls[2][0]).toContain("/tasks/t/abort"); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { ok: true } })); const lost = await teardownIndividualTask(new NextRequest("http://localhost/api/tasks/t", { method: "DELETE" }), context); expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("actual task route forwards opaque Auto/Agent/Goal/attachment inputs only to Backend and verifies the command ACK", async () => {
    const input = JSON.stringify({ projectId: null, prompt: "create", auto: true, agent: "auto", goalLoop: { enabled: true, maxTurns: 2 }, files: [] });
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, body: { task: { id: "t", status: "working", credentials: "PRIVATE" }, autoDecision: { providerID: "p", modelID: "m", variant: "", tier: "light", mode: "balanced", reason: "r", credentials: "PRIVATE" }, operation: { id, execution: "complete" } } });
    });
    const response = await createCollectionTask(new NextRequest("http://localhost/api/tasks", { method: "POST", body: input }));
    expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE"); expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(input);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { task: { id: "t", status: "working" } } }));
    const lost = await createCollectionTask(new NextRequest("http://localhost/api/tasks", { method: "POST", body: input })); expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(2); expect(readdirSync(root)).toEqual([]);
  });
  it("task list keeps query/ETag and bulk removal's execution ACK without business handling in Next", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 304, headers: { etag: "e" }, body: null }));
    expect((await collectionTasks(new NextRequest("http://localhost/api/tasks?paneCandidates=1&kind=all"))).status).toBe(304); expect(fetcher.mock.calls[0][0]).toContain("?paneCandidates=1&kind=all");
    fetcher.mockImplementationOnce(async (_url, options) => Response.json({ status: 200, body: { ok: true, removed: 2, operation: { id: new Headers(options.headers).get("x-leafcode-business-operation"), execution: "complete" } } }));
    expect((await (await clearArchivedTasks(new NextRequest("http://localhost/api/tasks?noProject=1", { method: "DELETE" }))).json()).removed).toBe(2); expect(readdirSync(root)).toEqual([]);
  });
  it("task attachment transport ceiling and UI auth refuse before contacting Backend", async () => {
    expect((await createCollectionTask(new NextRequest("http://localhost/api/tasks", { method: "POST", headers: { "content-length": String(TASK_COLLECTION_BODY_LIMIT + 1) }, body: "{}" }))).status).toBe(413);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); expect((await collectionTasks(new NextRequest("http://localhost/api/tasks"))).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  });
  it("actual Project route relays lifecycle input, verifies its execution ACK and never retries or falls back locally", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { project: { id: "p1", name: "P", rootPath: "C:\\moved", token: "PRIVATE" }, warning: "source cleanup pending", operation: { id, execution: "complete" } } });
    });
    const input = '{"id":"p1","destinationPath":"C:\\moved"}';
    const response = await patchProject(new NextRequest("http://localhost/api/projects", { method: "PATCH", body: input })); const body = await response.json();
    expect(response.status).toBe(200); expect(body).toMatchObject({ warning: "source cleanup pending", operation: { execution: "complete" } }); expect(JSON.stringify(body)).not.toContain("PRIVATE"); expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(input);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { project: { id: "p1", name: "P", rootPath: "C:\\moved" } } }));
    const lost = await patchProject(new NextRequest("http://localhost/api/projects", { method: "PATCH", body: input })); expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, headers: { etag: "e" }, body: { projects: [] } })); expect((await listProjects(new NextRequest("http://localhost/api/projects?archived=1"))).status).toBe(200); expect(fetcher.mock.calls[2][0]).toContain("/projects?archived=1"); expect(readdirSync(root)).toEqual([]);
  });
  it("actual Workspace routes relay ID/query/input without local filesystem/Git/model work or save ACK", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, headers: { "cache-control": "no-store" }, body: { name: "src/a.ts", mimeType: "text/plain", size: 1, data: "YQ==", token: "PRIVATE" } }));
    const file = await workspaceFiles(new NextRequest("http://localhost/api/projects/p%252Fone/files?path=src%2Fa.ts&read=1"), { params: Promise.resolve({ id: "p%2Fone" }) }); expect(file.status).toBe(200); expect(await file.json()).toEqual({ name: "src/a.ts", mimeType: "text/plain", size: 1, data: "YQ==" }); expect(fetcher.mock.calls[0][0]).toContain("/projects/p%252Fone/files?path=src%2Fa.ts&read=1");
    fetcher.mockImplementationOnce(async (_url, options) => { expect(new Headers(options.headers).has("x-leafcode-business-operation")).toBe(false); expect(new TextDecoder().decode(options.body)).toBe('{"model":"opaque input"}'); return Response.json({ status: 200, headers: {}, body: { suggestion: "Add tests", suggestions: ["Add tests"], source: "direct", model: { providerID: "fixture", modelID: "model", apiKey: "PRIVATE" } } }); });
    const response = await nextTask(new NextRequest("http://localhost/api/projects/p1/next-task", { method: "POST", body: '{"model":"opaque input"}' }), { params: Promise.resolve({ id: "p1" }) }); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE"); expect(fetcher).toHaveBeenCalledTimes(2); expect(readdirSync(root)).toEqual([]);
    expect((await nextTask(new NextRequest("http://localhost/api/projects/p1/next-task", { method: "POST", body: "x".repeat(320001) }), { params: Promise.resolve({ id: "p1" }) })).status).toBe(413); expect(fetcher).toHaveBeenCalledTimes(2);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); expect((await workspaceFiles(new NextRequest("http://localhost/api/projects/p1/files"), { params: Promise.resolve({ id: "p1" }) })).status).toBe(401); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("actual public Peer route carries only its separate bearer, hides refresh, preserves auth-first invalid body and rate-limit headers", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "UI-TOKEN");
    fetcher.mockImplementationOnce(async (_url, options) => {
      const headers = new Headers(options.headers); expect(headers.get("authorization")).toContain("owner-private-token"); expect(headers.get("x-leafcode-business-peer-authorization")).toBe("Bearer PEER-TOKEN"); expect(headers.get("cookie")).toBeNull(); expect(headers.get("x-leafcode-business-authorized")).toBe("0");
      return Response.json({ status: 200, headers: {}, body: { credential: { type: "oauth", access: "LEASE", expires: 999999, refresh: "PRIVATE" } } });
    });
    const response = await resolvePeer(new NextRequest("http://localhost/api/peer-auth/resolve", { method: "POST", headers: { authorization: "Bearer PEER-TOKEN", cookie: "private-other-cookie=PRIVATE" }, body: '{"providerId":"anthropic"}' }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ credential: { type: "oauth", access: "LEASE", expires: 999999 } });
    fetcher.mockImplementationOnce(async (_url, options) => { expect(options.body).toBeUndefined(); return Response.json({ status: 401, headers: {}, body: { error: "unauthorized" } }); });
    expect((await resolvePeer(new NextRequest("http://localhost/api/peer-auth/resolve", { method: "POST", body: "x".repeat(5000) }))).status).toBe(401);
    fetcher.mockResolvedValueOnce(Response.json({ status: 429, headers: { "retry-after": "7" }, body: { error: "rate-limited" } }));
    const limited = await resolvePeer(new NextRequest("http://localhost/api/peer-auth/resolve", { method: "POST", body: "{}" })); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("7");
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", ""); expect((await peerImports(new NextRequest("http://localhost/api/peer-auth/import"))).status).toBe(401); expect(fetcher).toHaveBeenCalledTimes(3); expect(readdirSync(root)).toEqual([]);
  });
  it("actual Next consume route verifies execution ACK, not a settings-save claim, and never retries an uncertain response", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, body: { ok: false, code: "nothing_to_reset", message: "safe", creditId: "c", accountId: null, windowsReset: null, token: "PRIVATE", operation: { id, execution: "complete" } } });
    });
    const body = '{"creditId":"c"}'; const response = await consumeResetCredit(new NextRequest("http://localhost/api/codexbar/reset-credits", { method: "POST", body }));
    expect(response.status).toBe(200); const outcome = await response.json(); expect(outcome).toMatchObject({ ok: false, operation: { execution: "complete" } }); expect(outcome.mutation).toBeUndefined(); expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(body); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { ok: true, code: "reset", creditId: "c" } }));
    const lost = await consumeResetCredit(new NextRequest("http://localhost/api/codexbar/reset-credits", { method: "POST", body })); expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("actual Next account route relays opaque credential input, verifies its receipt and never writes locally", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { ok: true, configured: true, managementKey: "PRIVATE", mutation: {
        operationId: id, saved: true, saveStatus: "complete", revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply: "not-required", recovery: "none" } } });
    });
    const input = '{"managementKey":"PRIVATE-CREDENTIAL"}';
    const response = await saveAccountKey(new NextRequest("http://localhost/api/accounts/fixture/openrouter-credits", { method: "POST", body: input }), { params: Promise.resolve({ id: "fixture" }) });
    expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(input);
    expect(fetcher.mock.calls[0][0]).toContain("/accounts/fixture/openrouter-credits"); expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, headers: {}, body: { ok: true, configured: true } }));
    const lost = await saveAccountKey(new NextRequest("http://localhost/api/accounts/fixture/openrouter-credits", { method: "POST", body: input }), { params: Promise.resolve({ id: "fixture" }) });
    expect((await lost.json()).execution).toBe("unknown"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("acknowledges auth execution without claiming asynchronous credential save and sends input only to the owner", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { sessionId: "session", apiKey: "PRIVATE", operation: { id, execution: "complete" } } });
    });
    const result = await relayJsonBusiness(new Request("http://localhost/api/providers/fixture/login", { method: "POST", body: '{"type":"api_key"}' }), "providers/fixture/login");
    expect(result.status).toBe(200); const body = await result.json(); expect(body).toMatchObject({ sessionId: "session", operation: { execution: "complete" } });
    expect(body.mutation).toBeUndefined(); expect(body.apiKey).toBeUndefined(); expect(fetcher).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe('{"type":"api_key"}'); expect(readdirSync(root)).toEqual([]);
  });
  it("relays provider identifier/query bytes and preserves a saved endpoint's deferred receipt", async () => {
    fetcher.mockImplementationOnce(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 200, headers: {}, body: { baseUrl: "https://fixture.test/v1", token: "PRIVATE", mutation: {
        operationId: id, saved: true, saveStatus: "complete", revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply: "deferred", recovery: "none" } } });
    });
    const response = await relayJsonBusiness(new Request("http://localhost/api/providers/leafcodecloud/base-url?accountId=account-1", { method: "PUT", body: '{"baseUrl":"https://fixture.test/v1"}' }), "providers/leafcodecloud/base-url");
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mutation: { saved: true, apply: "deferred" } });
    expect(fetcher.mock.calls[0][0]).toContain("/providers/leafcodecloud/base-url?accountId=account-1");
    expect(readdirSync(root)).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves definition save/apply failure and checks the opaque operation acknowledgement", async () => {
    fetcher.mockImplementation(async (_url, options) => {
      const id = new Headers(options.headers).get("x-leafcode-business-operation");
      return Response.json({ status: 503, headers: {}, body: { error: "apply failed", content: "Saved", path: "AGENTS.md", exists: true,
        mutation: { operationId: id, saved: true, saveStatus: "complete", revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply: "failed", recovery: "none", token: "PRIVATE" } } });
    });
    const result = await relayJsonBusiness(new Request("http://localhost/api/agents-md", { method: "PATCH", body: '{"content":"Saved"}' }), "agents-md");
    expect(result.status).toBe(503); const body = await result.json();
    expect(body.mutation).toMatchObject({ saved: true, apply: "failed" }); expect(body.mutation.token).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { content: "Saved", path: "AGENTS.md", exists: true } }));
    const lost = await relayJsonBusiness(new Request("http://localhost/api/agents-md", { method: "PATCH", body: "{}" }), "agents-md");
    expect(lost.status).toBe(503); expect((await lost.json()).execution).toBe("unknown");
  });
  it("relays dynamic identifiers without decoding business names and gates prompt transfers", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { draft: { name: "nested/name", systemPrompt: "Prompt", secret: "PRIVATE" }, filePath: "agent.md" }, headers: {} }));
    const draft = await relayJsonBusiness(new Request("http://localhost/api/agents/nested%2Fname"), "agents/nested%2Fname");
    expect(draft.status).toBe(200); expect((await draft.json()).draft.secret).toBeUndefined();
    expect(fetcher.mock.calls[0][0]).toContain("/agents/nested%2Fname");
    vi.stubEnv("LEAFCODE_PI_BIND_HOST", "0.0.0.0");
    expect((await relayJsonBusiness(request("prompts/transfer"), "prompts/transfer")).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("relays bytes verbatim without local business validation, persistence or private fields", async () => {
    const response = await relayJsonBusiness(request("git/init", "not valid JSON"), "git/init");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, directory: "repo" });
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe("not valid JSON");
    expect(response.headers.get("set-cookie")).toBeNull(); expect(readdirSync(root)).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves conditional GET and structured partial success", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ status: 304, body: null, headers: { etag: 'W/"etag"', "cache-control": "private, no-cache" } }));
    const response = await relayJsonBusiness(new Request("http://localhost/api/git/log?directory=repo", { headers: { "if-none-match": 'W/"etag"' } }), "git/log");
    expect(response.status).toBe(304); expect(await response.text()).toBe(""); expect(response.headers.get("etag")).toBe('W/"etag"'); expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("if-none-match")).toBe('W/"etag"');
    fetcher.mockResolvedValueOnce(Response.json({ status: 500, body: { error: "restore failed", mergeSucceeded: true, strandedOn: "main", restored: null }, headers: {} }));
    const merge = await relayJsonBusiness(request("git/merge"), "git/merge");
    expect(merge.status).toBe(500); expect(await merge.json()).toMatchObject({ mergeSucceeded: true, strandedOn: "main", restored: null });
  });
  it("lost or malformed owner responses are unknown and never retried", async () => {
    fetcher.mockRejectedValueOnce(new Error("PRIVATE ERROR"));
    const lost = await relayJsonBusiness(request(), "git/init");
    expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ execution: "unknown" }); expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(Response.json({ status: 200, body: { secret: "PRIVATE" } }));
    const malformed = await relayJsonBusiness(request(), "git/init");
    expect((await malformed.json()).execution).toBe("unknown"); expect(readdirSync(root)).toEqual([]);
  });
  it("rejects admission failures without executing business inputs", async () => {
    vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "");
    expect((await relayJsonBusiness(request(), "git/init")).status).toBe(503);
    vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "owner-private-token-1234567890123456789");
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "UI-TOKEN");
    expect((await relayJsonBusiness(request(), "git/init")).status).toBe(401);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    expect((await relayJsonBusiness(new Request("http://localhost/api/git/init", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }), "git/init")).status).toBe(403);
    expect((await relayJsonBusiness(new Request("http://localhost/api/git/init", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }), "git/init")).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never forwards browser credentials and propagates read cancellation", async () => {
    const abort = new AbortController();
    fetcher.mockImplementation(async (_url, options) => {
      const headers = new Headers(options.headers);
      expect(headers.get("cookie")).toBeNull(); expect(headers.get("authorization")).not.toContain("UI-TOKEN");
      return new Promise((_done, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const result = relayJsonBusiness(new Request("http://localhost/api/git/log", { signal: abort.signal, headers: { cookie: "leafcode-pi-token=UI-TOKEN" } }), "git/log");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); abort.abort();
    expect((await result).status).toBe(503); expect(readdirSync(root)).toEqual([]);
  });
});

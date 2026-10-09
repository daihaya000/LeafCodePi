import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { insertTask, insertBotTask, patchTask, listTasks, upsertProject } from "@/lib/store";
import * as owner from "@backend-runtime/lib/task-collection";
import { GET as ownerList, POST as ownerCreate } from "@backend-runtime/json-business/handlers/tasks/route";
let root: string;
beforeEach(() => { root=mkdtempSync(join(tmpdir(),"leafcode-task-collection-")); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend"); vi.stubEnv("LEAFCODE_PI_DATA_DIR",root); vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"agent")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root,{recursive:true,force:true}); });
async function request(method="GET", query="", body?: unknown, operationId=method==="GET"?undefined:randomUUID(), headers: Record<string,string>={}) {
  const result=await dispatchJsonBusinessRequest({route:"tasks",method,url:`http://localhost/api/tasks${query}`,headers:{host:"localhost",...headers},authorized:true,operationId,...(body===undefined?{}:{body:new TextEncoder().encode(JSON.stringify(body))})});
  const projected=publicJsonBusinessResult("tasks",result); expect(projected).not.toBeNull(); return {...projected!,body:projected!.body!};
}
describe("Backend task collection owner",()=>{
  it("real store rows, kind/archived/pane/sidebar/attention and ETag stay owner-derived",async()=>{
    const code=insertTask({project:null,title:"Code"}); patchTask(code.id,{label:"fixture"});
    insertBotTask({id:"bot:fixture",botId:"fixture",name:"Bot",directory:root});
    const rows=await request("GET","?titles=1&kind=all"); expect((rows.body.tasks as unknown[])).toHaveLength(2); expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    const pane=await request("GET","?paneCandidates=1"); expect((pane.body.tasks as Array<{id:string}>).map(t=>t.id)).toContain(code.id); expect(JSON.stringify(pane)).not.toContain("directory");
    const side=await request("GET","?view=sidebar"); expect((side.body.tasks as unknown[])).toHaveLength(1); expect(JSON.stringify(side)).not.toContain("sessionFile");
    expect((await request("GET","?attention=1")).body.attention).toEqual([]);
    const unchanged=await request("GET","?titles=1&kind=all",undefined,undefined,{"if-none-match":rows.headers.etag}); expect(unchanged.status).toBe(304);
  });
  it("bulk teardown only removes archived Code rows in the selected project and never Bots or active/unrelated rows",async()=>{
    const project=upsertProject({name:"P",rootPath:root}), other=upsertProject({name:"other",rootPath:join(root,"other")});
    const archived=insertTask({project,title:"delete"}), active=insertTask({project,title:"keep"}), unrelated=insertTask({project:other,title:"other"}), loose=insertTask({project:null,title:"loose"});
    for(const task of [archived,unrelated,loose])patchTask(task.id,{status:"archived"});
    const bot=insertBotTask({id:"bot:archived",botId:"archived",name:"Bot",directory:root});patchTask(bot.id,{status:"archived"});
    const id=randomUUID(), result=await request("DELETE",`?projectId=${project.id}`,undefined,id); expect(result.body).toMatchObject({ok:true,removed:1,operation:{id,execution:"complete"}});
    expect((await request("DELETE",`?projectId=${project.id}`,undefined,id)).status).toBe(409);
    expect(listTasks(true,"all").map(t=>t.id)).toEqual(expect.arrayContaining([active.id,unrelated.id,loose.id,bot.id]));
    expect((await request("DELETE","?noProject=1")).body.removed).toBe(1); expect(listTasks(true,"all").map(t=>t.id)).toContain(bot.id); expect(readFileSync(join(root,"task-collection-command.json"),"utf8")).not.toContain(project.id);
  });
  it("invalid IDs/attachments and cross-origin writes are rejected before task creation or deletion",async()=>{
    const before=listTasks(true,"all");
    for(const input of [{projectId:"../escape",prompt:"x"},{projectId:null,prompt:"x",accountId:2},{projectId:null,prompt:"x",files:[{name:"x",mimeType:"text/plain",data:"/w=="}]}]) expect((await request("POST","",input)).status).toBe(400);
    expect((await request("DELETE","?projectId=..%2Fx")).status).toBe(400); expect((await request("DELETE","?noProject=1",undefined,randomUUID(),{origin:"http://evil.test"})).status).toBe(403); expect(listTasks(true,"all")).toEqual(before);
  });
  it("Next is refused before model/Agent selection, maintenance, session creation, bulk teardown or ledger/files",async()=>{
    const before=readdirSync(root); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
    for(const action of [()=>owner.createTask({projectId:null,prompt:"x"}),()=>owner.destroyArchivedTasksByProject(null),()=>owner.autoArchiveOldTasks(),()=>owner.getTaskSummariesWithTodoProgress(),()=>owner.resolveAutoModel({prompt:"x",hasImages:false,mode:"balanced"}),()=>owner.listPendingAttention()])expect(action).toThrow("owned by Backend");
    await expect(request("POST","",{projectId:null,prompt:"x"})).rejects.toThrow("owned by Backend"); expect(readdirSync(root)).toEqual(before);
    await expect(ownerList(Object.assign(new Request("http://localhost/api/tasks?paneCandidates=1"), {nextUrl:new URL("http://localhost/api/tasks?paneCandidates=1")}))).rejects.toThrow("owned by Backend");
    await expect(ownerCreate(Object.assign(new Request("http://localhost/api/tasks", {method:"POST",body:JSON.stringify({projectId:null,prompt:"x",agent:"auto"})}), {nextUrl:new URL("http://localhost/api/tasks")}))).rejects.toThrow("owned by Backend");
  });
});

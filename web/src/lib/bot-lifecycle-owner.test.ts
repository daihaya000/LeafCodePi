import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bots from "@/lib/bots";
import * as harness from "@/lib/pi/harness";
import * as admin from "@/lib/bot-admin";
import * as entrances from "@backend-runtime/lib/bot-lifecycle-api";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { setSetting } from "@/lib/pi/web-settings";
import { BOT_TEMPLATES } from "@shared/bot-marketplace";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-bot-owner-")); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach"); vi.stubEnv("LEAFCODE_PI_DATA_DIR", root); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent")); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(method="GET", path="bots", body:unknown={}, id=randomUUID(), authorized=true, origin?:string, signal?:AbortSignal, headers:Record<string,string>={}) {
 const result = await dispatchJsonBusinessRequest({ route:path, method, url:`http://localhost/api/${path}`, headers:{ host:"localhost", ...headers, ...(origin?{origin}:{}) }, authorized, operationId:method==="GET"?undefined:id, signal, ...(method==="GET"?{}:{body:new TextEncoder().encode(typeof body==="string"?body:JSON.stringify(body))}) });
 const dto=publicJsonBusinessResult(path,result,method); expect(dto).not.toBeNull(); return dto!;
}
describe("Bot lifecycle Backend owner",()=>{
 it("creation chooses owner defaults/catalog, ignores caller privilege and persists only ID receipts",async()=>{
  setSetting("bot-default-permission","deny"); setSetting("bot-default-thinking","max");
  const id=randomUUID(), result=await request("POST","bots",{templateId:"researcher",model:"FORGED",permissionMode:"allow",codeAutoApprove:false,soul:"FORGED",directory:"FORGED"},id);
  expect(result.status).toBe(201); expect(result.body).toMatchObject({bot:{name:"リサーチャー",label:"調査アシスタント",soul:BOT_TEMPLATES[0].soul,permissionMode:"deny",thinkingLevel:"max",codeAutoApprove:true,model:null},operation:{id,execution:"complete"}});
  const bot=(result.body as any).bot; expect(readFileSync(join(root,"bots",bot.id,"SOUL.md"),"utf8")).toBe(bot.soul);
  expect((await request("POST","bots",{},id)).status).toBe(409);
  const ledger=readFileSync(join(root,"bot-lifecycle-command.json"),"utf8"); for(const text of ["FORGED",bot.id,bot.name,bot.soul]) expect(ledger).not.toContain(text);
  const listed=await request(); expect((listed.body as any).bots).toHaveLength(1); expect((listed.body as any).bots[0].codeSessionCount).toBe(0);
  expect((await request("GET","bots",{},randomUUID(),true,undefined,undefined,{"if-none-match":listed.headers.etag}))).toMatchObject({status:304,body:null});
 });
 it("invalid name/template refuses before config creation, with Unicode code-point bounds",async()=>{
  for(const body of [{name:2},{name:"x".repeat(101)},{templateId:2},{templateId:"missing"}]) expect((await request("POST","bots",body)).status).toBe(400);
  expect((await request()).body).toEqual({bots:[]});
  expect((await request("POST","bots",{name:"😀".repeat(100)})).status).toBe(201);
 });
 it("read refreshes only live tools; malformed success/failure becomes unknown, not an empty list",async()=>{
  const created=await request("POST","bots",{name:"Owner"}), bot=(created.body as any).bot, path=`bots/${bot.id}`, ensure=vi.spyOn(harness,"getTaskDetail"), refresh=vi.spyOn(harness,"setBotTools").mockImplementation(()=>{});
  expect((await request("GET",path)).body).toEqual({bot}); expect(refresh).toHaveBeenCalledWith(bot.id,bot.tools); expect(ensure).not.toHaveBeenCalled();
  const patch=vi.spyOn(admin,"handleBotPatch").mockResolvedValueOnce({status:200,body:{bot:{id:bot.id}}});
  const invalid=await request("PATCH",path,{name:"ignored"}); expect(invalid.status).toBe(503); expect(invalid.body).toMatchObject({operation:{execution:"unknown"}});
  patch.mockRejectedValueOnce(new Error("PRIVATE fs/path")); const id=randomUUID(); expect((await request("PATCH",path,{},id)).body).toMatchObject({error:"Bot設定の処理結果を確認できません",operation:{execution:"unknown"}}); expect((await request("PATCH",path,{},id)).status).toBe(409);
  vi.spyOn(bots,"listBots").mockImplementation(()=>{throw new Error("PRIVATE");}); expect((await request()).status).toBe(503);
 });
 it("the existing avatar plus worst-case escaped SOUL budget fits; partial post-save SDK failure remains unknown",async()=>{
  const created=await request("POST","bots",{}),bot=(created.body as any).bot,path=`bots/${bot.id}`;
  const avatarImage="data:image/png;base64,"+"A".repeat(3_000_000-"data:image/png;base64,".length),soul="\u0001".repeat(128*1024),body={avatarImage,soul};expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(4*1024*1024);
  const saved=await request("PATCH",path,body);expect(saved.status).toBe(200);expect((saved.body as any).bot.avatarImage).toBe(avatarImage);expect((saved.body as any).bot.soul).toBe(soul);
  vi.spyOn(harness,"setBotTools").mockImplementation(()=>{throw new Error("PRIVATE post-save SDK/path");});
  const id=randomUUID(),failed=await request("PATCH",path,{name:"Saved before failure",tools:["read"]},id);
  expect(failed.status).toBe(503);expect(failed.body).toMatchObject({error:"Bot設定の処理結果を確認できません",operation:{execution:"unknown"}});expect(JSON.stringify(failed.body)).not.toContain("PRIVATE");
  expect(bots.getBot(bot.id)?.name).toBe("Saved before failure");expect((await request("PATCH",path,{name:"No retry"},id)).status).toBe(409);
 });
 it("serial mutations preserve order and survive caller disconnect without replaying teardown",async()=>{
  const created=await request("POST","bots",{}),bot=(created.body as any).bot,path=`bots/${bot.id}`,controller=new AbortController();let finish!:(value:admin.BotAdminResult)=>void;
  const patch=vi.spyOn(admin,"handleBotPatch").mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})),remove=vi.spyOn(admin,"handleBotDelete").mockResolvedValue({status:200,body:{ok:true}}),id=randomUUID();
  const held=request("PATCH",path,{name:"renamed"},id,true,undefined,controller.signal); await vi.waitFor(()=>expect(patch).toHaveBeenCalledOnce()); const queued=request("DELETE",path,{}); await Promise.resolve(); expect(remove).not.toHaveBeenCalled(); controller.abort(); finish({status:200,body:{bot}});
  expect((await held).status).toBe(200); expect((await queued).status).toBe(200); expect(remove).toHaveBeenCalledOnce(); expect((await request("PATCH",path,{},id)).status).toBe(409);
 });
 it("auth/Origin/bounds/IDs and all Next entrances refuse before Bot/SDK/filesystem work",async()=>{
  const create=vi.spyOn(bots,"createBot"),get=vi.spyOn(bots,"getBot"),list=vi.spyOn(bots,"listBots"),patch=vi.spyOn(bots,"patchBot"),before=readdirSync(root),id="11111111-0123-4321-abcd-eeeeeeeeeeee";
  for(const method of ["GET","POST"])expect((await request(method,"bots",{},randomUUID(),false)).status).toBe(401);
  expect((await request("POST","bots",{},randomUUID(),true,"https://evil.test")).status).toBe(403);
  expect((await request("POST","bots","x".repeat(4097))).status).toBe(413);
  expect((await request("PATCH",`bots/${id}`,"x".repeat(4*1024*1024+1))).status).toBe(413); expect(readdirSync(root)).toEqual(before);
  for(const selector of ["..%2Fx","%252F","bad-id",id+"a".repeat(129)])expect((await request("GET",`bots/${selector}`)).status).toBe(400);
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
  for(const fn of [()=>entrances.readBotCollection(),()=>entrances.readBotConfiguration(id),()=>entrances.createBotConfiguration({})])expect(fn).toThrow("owned by Backend");
  await expect(admin.handleBotPatch(id,{})).rejects.toThrow("owned by Backend"); await expect(admin.handleBotDelete(id)).rejects.toThrow("owned by Backend"); await expect(request()).rejects.toThrow("owned by Backend");
  for(const spy of [create,get,list,patch])expect(spy).not.toHaveBeenCalled();
 });
});

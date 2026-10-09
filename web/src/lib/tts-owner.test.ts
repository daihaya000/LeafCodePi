import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { writeTtsConfig, readTtsConfig } from "@backend-runtime/lib/tts-config";
import { synthesizeTts, TtsSynthesizeError } from "@backend-runtime/lib/tts-synthesize";
import * as synth from "@backend-runtime/lib/tts-synthesize";
import { createBot, patchBot } from "@backend-runtime/lib/bots";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-tts-owner-"));
  for (const [key,value] of Object.entries({LEAFCODE_PI_PROCESS_ROLE:"backend",LEAFCODE_PI_DATA_DIR:root,PI_CODING_AGENT_DIR:join(root,"agent"),LEAFCODE_PI_WEBUI_AUTH:"required"})) vi.stubEnv(key,value);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root,{recursive:true,force:true}); });
const request = (route="tts/synthesize", body: unknown={text:"こんにちは"}, extra: Record<string,any>={}) => dispatchJsonBusinessRequest({route,method:route==="tts/synthesize"?"POST":"GET",url:"http://localhost/api/"+route,headers:{},authorized:true,operationId:randomUUID(),...(route==="tts/synthesize"?{body:new TextEncoder().encode(JSON.stringify(body))}:{}),...extra});
it("development Next refuses owner readers/writers/synthesis/dispatch before FS or fetch",async()=>{
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next"); const fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
  expect(readTtsConfig).toThrow(/owned by Backend/); expect(()=>writeTtsConfig({enabled:true})).toThrow(/owned by Backend/);
  await expect(synthesizeTts("x","http://private/v1/tts","1")).rejects.toThrow(/owned by Backend/);
  await expect(request()).rejects.toThrow(/owned by Backend/); expect(fetch).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
});
it("owner global/Bot voice wins over caller URL/voice/config; replay never synthesizes again",async()=>{
  writeTtsConfig({enabled:true,url:"http://engine.test/v1/audio/speech",voice:"global"}); const bot=createBot({name:"fixture"}); patchBot(bot.id,{ttsVoice:"bot"});
  const fetch=vi.fn(async(_url: string, _options: RequestInit)=>new Response(new Uint8Array([0,1,255]),{headers:{"content-type":"audio/mpeg"}})); vi.stubGlobal("fetch",fetch);
  const id=randomUUID(); const result=await request("tts/synthesize",{text:" 日本語 ",botId:bot.id,url:"PRIVATE",voice:"FORGED",config:{enabled:false}},{operationId:id});
  expect(result.status).toBe(200); expect(result.body).toEqual({audio:{contentType:"audio/mpeg",base64:"AAH/"},operation:{id,execution:"complete"}});
  expect(fetch.mock.calls[0][0]).toBe("http://engine.test/v1/audio/speech"); expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toMatchObject({input:"日本語",voice:"bot"});
  expect((await request("tts/synthesize",{text:"FORGED"},{operationId:id})).status).toBe(409); expect(fetch).toHaveBeenCalledOnce();
  const ledger=readFileSync(join(root,"tts-synthesis-command.json"),"utf8"); for(const secret of["日本語","engine.test","AAH/",bot.id])expect(ledger).not.toContain(secret);
});
it("authorization/Origin/opaque body bounds precede effects and malformed input does not contact engine",async()=>{
  writeTtsConfig({enabled:true,url:"http://engine.test/v1/tts"}); const fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
  expect((await request(undefined,undefined,{authorized:false})).status).toBe(401);
  expect((await request(undefined,undefined,{headers:{origin:"https://evil.invalid"}})).status).toBe(403);
  expect((await request(undefined,undefined,{body:new Uint8Array(16*1024+1)})).status).toBe(413);
  for(const body of[{}, {text:"x".repeat(2001)}, {text:"x",botId:"../private"}, {text:"x",botId:7}])expect((await request("tts/synthesize",body)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it("unknown engine effects and post-start typed 4xx never turn into complete receipts or leak failures",async()=>{
  writeTtsConfig({enabled:true,url:"http://engine.test/v1/tts"});
  vi.spyOn(synth,"synthesizeTts").mockImplementationOnce(async(_text,_url,_voice,options)=>{options?.onStart?.();throw new TtsSynthesizeError("PRIVATE failure",400);});
  const id=randomUUID(), result=await request(undefined,undefined,{operationId:id}); expect(result.status).toBe(503); expect(result.body?.operation).toEqual({id,execution:"unknown"}); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect((await request(undefined,undefined,{operationId:id})).status).toBe(409);
});
it("accepted synthesis continues after caller abort; concurrent commands do not serialize behind generation",async()=>{
  writeTtsConfig({enabled:true,url:"http://engine.test/v1/tts"}); let release!:()=>void; let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}); const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetch=vi.fn(async()=>{entered();await gate;return new Response(new Uint8Array([1]),{headers:{"content-type":"audio/wav"}});});vi.stubGlobal("fetch",fetch);
  const abort=new AbortController(),id=randomUUID(),pending=request(undefined,undefined,{operationId:id,signal:abort.signal});await started;abort.abort();
  const unrelated=await request("tts/synthesize",{});expect(unrelated.status).toBe(400);release();const result=await pending;expect(result.status).toBe(200);expect(result.body?.operation).toEqual({id,execution:"complete"});
});
it("disabled and custom-URL authorization refusals are complete/no provider attempt; custom voices are empty/no probe",async()=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);writeTtsConfig({enabled:false,url:"http://engine.test/v1/tts"});
  const result=await request();expect(result.status).toBe(400);expect((result.body?.operation as {execution:string}).execution).toBe("complete");
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");expect((await request(undefined,undefined,{authorized:false})).status).toBe(401);
  const voices=await request("settings/tts/voices");expect(voices.body).toEqual({voices:[]});expect(fetch).not.toHaveBeenCalled();
});

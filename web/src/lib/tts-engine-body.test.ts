import { afterEach, expect, it, vi } from "vitest";
import { readTtsEngineText, TTS_MAX_ENGINE_JSON_BYTES } from "@backend-runtime/lib/tts-engine-body";
import { synthesizeTts } from "@backend-runtime/lib/tts-synthesize";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it("metadata reader rejects Next before touching stream headers",async()=>{
 vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");const response={get headers(){throw new Error("PRIVATE");}} as unknown as Response;
 await expect(readTtsEngineText(response)).rejects.toThrow(/owned by Backend/);
});
it("declared and streaming metadata caps cancel before parser/provider stage; invalid UTF8 fails closed",async()=>{
 await expect(readTtsEngineText(new Response("x",{headers:{"content-length":String(TTS_MAX_ENGINE_JSON_BYTES+1)}}))).rejects.toThrow(/too large/);
 let count=0;const body=new ReadableStream<Uint8Array>({pull(c){count++;c.enqueue(new Uint8Array(2*1024*1024));if(count>20)c.close();}});
 await expect(readTtsEngineText(new Response(body))).rejects.toThrow(/too large/);expect(count).toBeLessThan(10);
 await expect(readTtsEngineText(new Response(new Uint8Array([255])))).rejects.toThrow();
 expect(await readTtsEngineText(new Response('{"日本語":1}'))).toBe('{"日本語":1}');
});
it("oversized Voicevox query never reaches synthesis, and raw metadata failure is not exposed",async()=>{
 const fetch=vi.fn(async()=>new Response("PRIVATE",{headers:{"content-length":String(TTS_MAX_ENGINE_JSON_BYTES+1)}}));vi.stubGlobal("fetch",fetch);
 await expect(synthesizeTts("日本語","http://engine.test","1")).rejects.toThrow(/接続/);expect(fetch).toHaveBeenCalledOnce();
});

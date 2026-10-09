import { mkdtempSync, rmSync, writeFileSync, truncateSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTaskFileStream, readTaskFileStreamDiagnostics } from "@backend-runtime/file-stream/task-files";
import { resolveTaskLocalFile } from "@backend-runtime/lib/local-file";
import { relayTaskFileStream } from "./task-file-stream-relay";
import { GET as nextImage } from "../app/api/tasks/[id]/image/route";
import { GET as nextMedia, HEAD as nextHead } from "../app/api/tasks/[id]/media/route";
import { BACKEND_PROTOCOL_HEADER } from "@shared/backend-protocol.mjs";
vi.mock("@/lib/backend-file-transport",()=>({openBackendFileSource:(url:string,init:RequestInit)=>fetch(url,init)}));
const store=vi.hoisted(()=>({getTask:vi.fn(),getProject:vi.fn(),listProjects:vi.fn(()=>[])}));vi.mock("@/lib/store",()=>store);
let root:string;
const bytes=Buffer.from("RIFF0000WAVEfmt data test audio");
const source=(extra:any={})=>openTaskFileStream({route:"tasks/task/media",method:"GET",url:"http://localhost/api/tasks/task/media?path=a.wav",headers:{},authorized:true,signal:new AbortController().signal,...extra});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-file-owner-"));writeFileSync(join(root,"a.wav"),bytes);store.getTask.mockReturnValue({directory:root});store.getProject.mockReturnValue(undefined);vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");vi.stubEnv("LEAFCODE_PI_DATA_DIR",root);vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN","x".repeat(32));vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION","");});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();rmSync(root,{recursive:true,force:true});expect(readTaskFileStreamDiagnostics().active).toBe(0);expect(readTaskFileStreamDiagnostics().descriptors).toBe(0);});
it("development Next and denied access cannot resolve paths or open descriptors",async()=>{
 vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");expect(()=>resolveTaskLocalFile("task","a.wav")).toThrow(/owned by Backend/);await expect(source()).rejects.toThrow(/owned by Backend/);vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");const lookup=store.getTask.mock.calls.length;expect((await source({authorized:false})).status).toBe(401);expect(store.getTask.mock.calls.length).toBe(lookup);expect(readdirSync(root)).toEqual(["a.wav"]);
});
it("no demand means no payload IO; cancellation and AbortSignal release the descriptor",async()=>{
 truncateSync(join(root,"a.wav"),512*1024*1024);const before=readTaskFileStreamDiagnostics().bytesRead;const controller=new AbortController();const response=await source({signal:controller.signal});expect(readTaskFileStreamDiagnostics().bytesRead).toBe(before);controller.abort();await response.body!.cancel();expect(readTaskFileStreamDiagnostics().bytesRead).toBe(before);expect(readTaskFileStreamDiagnostics().descriptors).toBe(0);
});
it("range and descriptor cap bound all active allocations",async()=>{
 const streams:Response[]=[];try{for(let i=0;i<32;i++)streams.push(await source());expect((await source()).status).toBe(503);expect(readTaskFileStreamDiagnostics().active).toBe(32);expect(readTaskFileStreamDiagnostics().chunkBytes).toBe(65536);}finally{await Promise.all(streams.map(r=>r.body!.cancel()));}
 expect((await source({headers:{range:"bytes=9999-"}})).status).toBe(416);
});
it("changed files terminate rather than returning a successful truncated body",async()=>{
 const response=await source();truncateSync(join(root,"a.wav"),1);await expect(response.arrayBuffer()).rejects.toThrow();expect(readTaskFileStreamDiagnostics().descriptors).toBe(0);
});
it("Next routes relay only, preserve Range/HEAD and strip private headers",async()=>{
 vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");vi.stubGlobal("fetch",vi.fn(async(_url,options)=>new Response(options.method==="HEAD"?null:bytes,{status:options.headers.range?206:200,headers:{[BACKEND_PROTOCOL_HEADER]:"1","content-type":"audio/wav","content-length":String(bytes.length),"content-range":"bytes 0-3/30","set-cookie":"PRIVATE","x-private":"PRIVATE"}})));
 const req=new Request("http://localhost/api/tasks/task/media?path=a.wav",{headers:{range:"bytes=0-3"}});const response=await nextMedia(req as any,{params:Promise.resolve({id:"task"})});expect(response.status).toBe(206);expect(response.headers.has("set-cookie")).toBe(false);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);expect((fetch as any).mock.calls[0][1].headers.range).toBe("bytes=0-3");expect((await nextHead(new Request(req.url,{method:"HEAD"}) as any,{params:Promise.resolve({id:"task"})})).body).toBeNull();expect((await nextImage(new Request("http://localhost/api/tasks/task/image") as any,{params:Promise.resolve({id:"task"})})).status).toBe(200);
});
it("relay cancellation aborts upstream even when nothing was consumed",async()=>{
 vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");let cancelled=false,signal!:AbortSignal;vi.stubGlobal("fetch",vi.fn(async(_url,options)=>{signal=options.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{[BACKEND_PROTOCOL_HEADER]:"1","content-type":"audio/wav"}});}));const response=await relayTaskFileStream(new Request("http://localhost/api/tasks/task/media"),"tasks/task/media");await response.body!.cancel();expect(signal.aborted).toBe(true);expect(cancelled).toBe(true);
});
it("relay auth/method/generation refusals never contact a local path",async()=>{
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);expect((await relayTaskFileStream(new Request("http://localhost"),"tasks/task/media")).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");expect((await relayTaskFileStream(new Request("http://localhost",{method:"POST"}),"tasks/task/image")).status).toBe(405);expect(fetcher).not.toHaveBeenCalled();
});

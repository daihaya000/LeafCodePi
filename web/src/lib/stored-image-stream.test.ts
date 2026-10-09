import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTaskFileStream, readTaskFileStreamDiagnostics } from "@backend-runtime/file-stream/task-files";
const dependencies = vi.hoisted(()=>({getProjectIcon:vi.fn(),getLinkPreviewImage:vi.fn(),readLinkPreviewImageDiagnostics:vi.fn(()=>({activePreviewFetches:0,previewWaiters:0,cachedPreviewBytes:0}))}));
vi.mock("@/lib/store",()=>({getProjectIcon:dependencies.getProjectIcon}));
vi.mock("@/lib/link-preview",()=>({getLinkPreviewImage:dependencies.getLinkPreviewImage,readLinkPreviewImageDiagnostics:dependencies.readLinkPreviewImageDiagnostics}));
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=","base64");
const source=(route="projects/p/icon",extra:any={})=>openTaskFileStream({route,method:"GET",url:"http://localhost/api/"+route,headers:{},authorized:true,signal:new AbortController().signal,...extra});
beforeEach(()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");dependencies.getProjectIcon.mockReset().mockReturnValue("data:image/png;base64,"+png.toString("base64"));dependencies.getLinkPreviewImage.mockReset().mockResolvedValue({bytes:png,mime:"image/png"});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();const stats=readTaskFileStreamDiagnostics();expect(stats.active).toBe(0);expect(stats.descriptors).toBe(0);});
it("all read-only assets check auth, ID, method, role and preabort before store/cache",async()=>{
 expect((await source(undefined,{authorized:false})).status).toBe(401);
 expect((await source("projects/a%2Fb/icon")).status).toBe(404);
 expect((await source(undefined,{method:"POST"})).status).toBe(405);
 const controller=new AbortController();controller.abort();expect((await source(undefined,{signal:controller.signal})).status).toBe(400);
 vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(source()).rejects.toThrow(/owned by Backend/);
 expect(dependencies.getProjectIcon).not.toHaveBeenCalled();expect(dependencies.getLinkPreviewImage).not.toHaveBeenCalled();
});
it("preview ID stays opaque, no URL fallback, private no-referrer headers and exact Range",async()=>{
 const response=await source("link-preview/image",{url:"http://localhost/api/link-preview/image?id="+"a".repeat(32)+"&url=http://PRIVATE/",headers:{range:"bytes=3-17"}});
 expect(response.status).toBe(206);expect(Buffer.from(await response.arrayBuffer())).toEqual(png.subarray(3,18));expect(dependencies.getLinkPreviewImage.mock.calls[0][0]).toBe("a".repeat(32));expect(dependencies.getLinkPreviewImage.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
 for(const [key,value]of Object.entries({"cache-control":"private, max-age=300","referrer-policy":"no-referrer","cross-origin-resource-policy":"same-origin","x-content-type-options":"nosniff"}))expect(response.headers.get(key)).toBe(value);
 dependencies.getLinkPreviewImage.mockResolvedValue(null);expect((await source("link-preview/image")).status).toBe(404);
});
it("project base64 Range crosses every group alignment without decoding the whole image",async()=>{
 const bytes=Buffer.alloc(2*1024*1024,123);png.copy(bytes);dependencies.getProjectIcon.mockReturnValue("data:image/png;base64,"+bytes.toString("base64"));
 const original=Buffer.from,decoded:number[]=[];vi.spyOn(Buffer,"from").mockImplementation(((data:any,...args:any[])=>{const out=(original as any)(data,...args);if(args[0]==="base64")decoded.push(out.length);return out;}) as any);
 for(const start of [0,1,2,65535,65536,bytes.length-7]){
  const response=await source(undefined,{headers:{range:`bytes=${start}-${Math.min(bytes.length-1,start+65538)}`}});
  expect(response.status).toBe(206);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start,Math.min(bytes.length,start+65539)));
 }
 expect(Math.max(...decoded)).toBeLessThanOrEqual(65538);
});
it("HEAD/416/If-Range have stable length and no source body; oversized or corrupt icons fail closed",async()=>{
 const head=await source(undefined,{method:"HEAD",headers:{range:"bytes=1-2"}});expect(head.body).toBeNull();expect(head.headers.get("content-length")).toBe(String(png.length));
 expect((await source(undefined,{headers:{range:"bytes=999999-"}})).status).toBe(416);
 const full=await source(undefined,{headers:{"if-range":"old",range:"bytes=0-1"}});expect(full.status).toBe(200);await full.body!.cancel();
 for(const icon of ["data:image/png;base64,AR==","data:image/png;base64,"+Buffer.from("<svg/>").toString("base64"),"data:image/png;base64,"+"A".repeat(4*Math.ceil(2*1024*1024/3)+200)]){
  dependencies.getProjectIcon.mockReturnValue(icon);expect((await source()).status).toBeGreaterThanOrEqual(400);
 }
});
it("ICO aliases preserve legacy MIME and never load a browser-selected path",async()=>{
 for(const mime of ["image/x-icon","image/vnd.microsoft.icon"]){
  const ico=Buffer.from([0,0,1,0,1,0,32,32]);dependencies.getProjectIcon.mockReturnValue(`data:${mime};base64,${ico.toString("base64")}`);
  const response=await source(undefined,{url:"http://localhost/api/projects/p/icon?path=PRIVATE"});expect(response.headers.get("content-type")).toBe(mime);expect(Buffer.from(await response.arrayBuffer())).toEqual(ico);
 }
});
it("no-demand, parallel admission, consumer cancel and AbortSignal release all asset snapshots",async()=>{
 const bytes=Buffer.alloc(2*1024*1024);png.copy(bytes);dependencies.getProjectIcon.mockReturnValue("data:image/png;base64,"+bytes.toString("base64"));
 const before=readTaskFileStreamDiagnostics().bytesRead,controller=new AbortController();const response=await source(undefined,{signal:controller.signal});expect(readTaskFileStreamDiagnostics().bytesRead).toBe(before);controller.abort();await response.body!.cancel();
 const opened=await Promise.all(Array.from({length:32},()=>source()));expect((await source()).status).toBe(503);await Promise.all(opened.map(r=>r.body!.cancel()));expect(readTaskFileStreamDiagnostics().active).toBe(0);
});

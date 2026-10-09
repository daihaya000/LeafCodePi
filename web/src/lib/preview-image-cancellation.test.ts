import { beforeEach, expect, it, vi } from "vitest";
const remote=vi.hoisted(()=>vi.fn());
vi.mock("./public-web-fetch",()=>({fetchPublicWebBytes:remote}));
import { getLinkPreview, getLinkPreviewImage, readLinkPreviewImageDiagnostics } from "./link-preview";
const png=Buffer.from([137,80,78,71,13,10,26,10]);
beforeEach(()=>{remote.mockReset();const state=(globalThis as any).__leafcodeLinkPreviews;if(state){expect(state.activeImages).toBe(0);expect(state.imageReaders??0).toBe(0);state.pages.clear();state.pending.clear();state.images.clear();state.cachedImageBytes=0;}});
async function register(){remote.mockResolvedValueOnce({bytes:Buffer.from('<title>fixture</title><meta property="og:image" content="/thumb.png">'),contentType:"text/html",url:"https://example.com/page"});const preview=await getLinkPreview("https://example.com/page");return new URL(preview.image!,"http://localhost").searchParams.get("id")!;}
it("one departed consumer does not cancel a shared image; the survivor gets the same cached bytes",async()=>{
 const id=await register();let finish!:(data:any)=>void;let signal!:AbortSignal;
 remote.mockImplementationOnce((_url,options)=>{signal=options.signal;return new Promise(r=>{finish=r;});});
 const first=new AbortController(),second=new AbortController();const a=getLinkPreviewImage(id,first.signal),b=getLinkPreviewImage(id,second.signal);first.abort();expect(await a).toBeNull();expect(signal.aborted).toBe(false);expect(readLinkPreviewImageDiagnostics().previewWaiters).toBe(1);
 finish({bytes:png,contentType:"image/png",url:"https://example.com/thumb.png"});expect(await b).toEqual({bytes:png,mime:"image/png"});expect(readLinkPreviewImageDiagnostics()).toMatchObject({activePreviewFetches:0,previewWaiters:0});expect((await getLinkPreviewImage(id))!.bytes).toEqual(png);expect(remote).toHaveBeenCalledTimes(2);
});
it("last-reader abort reaches network IO, frees every waiter and preserves the opaque ID for reconnect",async()=>{
 const id=await register();let signal!:AbortSignal;
 remote.mockImplementationOnce((_url,options)=>{signal=options.signal;return new Promise((_r,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));});
 const a=new AbortController(),b=new AbortController(),pa=getLinkPreviewImage(id,a.signal),pb=getLinkPreviewImage(id,b.signal);a.abort();await pa;b.abort();await pb;expect(signal.aborted).toBe(true);
 await vi.waitFor(()=>expect(readLinkPreviewImageDiagnostics()).toMatchObject({activePreviewFetches:0,previewWaiters:0}));
 remote.mockResolvedValueOnce({bytes:png,contentType:"image/png",url:"https://example.com/thumb.png"});expect((await getLinkPreviewImage(id))!.bytes).toEqual(png);expect(remote).toHaveBeenCalledTimes(3);
});
it("a reconnect cancelled behind an aborted network job does not wait for stale IO cleanup",async()=>{
 const id=await register();let finish!:()=>void;
 remote.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{finish=()=>reject(new Error("old IO stopped"));}));
 const old=new AbortController(),first=getLinkPreviewImage(id,old.signal);old.abort();await first;
 const retry=new AbortController(),waiting=getLinkPreviewImage(id,retry.signal);retry.abort();expect(await waiting).toBeNull();expect(readLinkPreviewImageDiagnostics().previewWaiters).toBe(0);
 finish();await vi.waitFor(()=>expect(readLinkPreviewImageDiagnostics().activePreviewFetches).toBe(0));
});
it("aborted and unknown-ID consumers never start remote IO",async()=>{
 const controller=new AbortController();controller.abort();expect(await getLinkPreviewImage("a".repeat(32),controller.signal)).toBeNull();expect(await getLinkPreviewImage("https://private/image")).toBeNull();expect(remote).not.toHaveBeenCalled();
});

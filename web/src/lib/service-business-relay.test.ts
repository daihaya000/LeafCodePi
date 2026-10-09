import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayJsonBusiness } from "./json-business-relay";
const fetcher=vi.fn();
beforeEach(()=>{for(const[key,value]of Object.entries({LEAFCODE_PI_PROCESS_ROLE:"next",LEAFCODE_PI_WEBUI_AUTH:"",LEAFCODE_PI_WEBUI_TOKEN:"",LEAFCODE_PI_BACKEND_TOKEN:"fixture-backend-token",LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:""}))vi.stubEnv(key,value);fetcher.mockReset();vi.stubGlobal("fetch",fetcher);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const post=(route:string,body='{"url":"https://example.com/?token=PRIVATE"}')=>new Request("http://localhost/api/"+route,{method:"POST",headers:{"content-type":"application/json"},body});
it("preview keeps opaque URLs out of transport paths, has no ledger ID and projects only metadata",async()=>{
  fetcher.mockResolvedValue(Response.json({status:200,headers:{"set-cookie":"PRIVATE"},body:{url:"https://example.com/",title:"日本語",sourceUrl:"PRIVATE"}}));
  const request=post("link-preview"),response=await relayJsonBusiness(request,"link-preview");expect(response.status).toBe(200);expect(await response.json()).toEqual({url:"https://example.com/",title:"日本語"});
  const[url,options]=fetcher.mock.calls[0];expect(url).not.toContain("token=");expect(new TextDecoder().decode(options.body)).toBe('{"url":"https://example.com/?token=PRIVATE"}');expect(new Headers(options.headers).has("x-leafcode-business-operation")).toBe(false);
});
it("preview image has no legacy JSON/base64 fallback",async()=>{
  expect((await relayJsonBusiness(new Request("http://localhost/api/link-preview/image"),"link-preview/image")).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
});
it("translation requires an exact complete operation ACK and never retries failures",async()=>{
  fetcher.mockImplementationOnce(async(_url,options)=>Response.json({status:200,body:{translations:["日本語"],fallbacks:[false],operation:{id:new Headers(options.headers).get("x-leafcode-business-operation"),execution:"complete"}}}));
  expect((await relayJsonBusiness(post("translation/reasoning",'{"texts":["Hello"],"url":"ignored"}'),"translation/reasoning")).status).toBe(200);
  for(const operation of[undefined,{id:"11111111-0123-4321-abcd-eeeeeeeeeeee",execution:"complete"}]){fetcher.mockResolvedValueOnce(Response.json({status:200,body:{translations:["x"],...(operation?{operation}:{})}}));expect((await relayJsonBusiness(post("translation/reasoning"),"translation/reasoning")).status).toBe(503);}
  fetcher.mockRejectedValueOnce(new Error("PRIVATE"));const result=await relayJsonBusiness(post("translation/reasoning"),"translation/reasoning");expect(result.status).toBe(503);expect(await result.text()).not.toContain("PRIVATE");expect(fetcher).toHaveBeenCalledTimes(4);
});
it("authorization, Origin and opaque byte bounds run before any Backend request",async()=>{
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await relayJsonBusiness(post("link-preview"),"link-preview")).status).toBe(401);vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");
  const foreign=post("link-preview");foreign.headers.set("origin","https://evil.invalid");expect((await relayJsonBusiness(foreign,"link-preview")).status).toBe(403);
  expect((await relayJsonBusiness(post("link-preview","x".repeat(32769)),"link-preview")).status).toBe(413);expect(fetcher).not.toHaveBeenCalled();
});
it("stalled request bodies time out and cancel the stream instead of admitting an empty body",async()=>{
  vi.useFakeTimers();const cancel=vi.fn();const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel});
  const req=new Request("http://localhost/api/link-preview",{method:"POST",body,duplex:"half"} as RequestInit);
  const pending=relayJsonBusiness(req,"link-preview");await vi.advanceTimersByTimeAsync(2001);expect((await pending).status).toBe(408);expect(cancel).toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
it("malformed task/image/translation successes fail closed at the public boundary",async()=>{
  for(const[route,body]of[["backend/tasks",{source:"backend",tasks:[{}]}],["translation/reasoning",{translations:[1]}]]as const){fetcher.mockResolvedValueOnce(Response.json({status:200,body}));expect((await relayJsonBusiness(route==="translation/reasoning"?post(route):new Request("http://localhost/api/"+route),route)).status).toBe(503);}
});

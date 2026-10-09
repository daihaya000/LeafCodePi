import { NextRequest } from "next/server";
import { mkdtempSync,readdirSync,rmSync } from "node:fs";
import { join } from "node:path";import { tmpdir } from "node:os";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { GET,POST } from "./route";
let root:string;const remote=vi.fn();
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-browse-bff-"));for(const [key,value] of Object.entries({LEAFCODE_PI_DATA_DIR:root,PI_CODING_AGENT_DIR:root,LEAFCODE_PI_PROCESS_ROLE:"next",LEAFCODE_PI_WEBUI_AUTH:"",LEAFCODE_PI_WEBUI_TOKEN:"",LEAFCODE_PI_BACKEND_TOKEN:"private-backend-token-1234567890123456789",LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:"",LEAFCODE_PI_HOST_CONTROL_URL:"http://127.0.0.1:18775"}))vi.stubEnv(key,value);remote.mockReset();vi.stubGlobal("fetch",remote);});
afterEach(()=>{expect(readdirSync(root)).toEqual([]);vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
it("GET keeps opaque query and canonical owner projection, without filesystem/command fallback",async()=>{
 remote.mockResolvedValueOnce(Response.json({status:200,body:{path:"owner",parent:null,entries:[],quickAccess:[],drives:[],secret:"PRIVATE"}}));
 const result=await GET(new NextRequest("http://localhost/api/browse/dirs?path=opaque%2Fselection"));expect(result.status).toBe(200);expect(JSON.stringify(await result.json())).not.toContain("PRIVATE");expect(remote.mock.calls[0][0]).toContain("?path=opaque%2Fselection");
 remote.mockRejectedValueOnce(new Error("PRIVATE"));expect((await GET(new NextRequest("http://localhost"))).status).toBe(503);
 vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN","");expect((await GET(new NextRequest("http://localhost"))).status).toBe(503);expect(remote).toHaveBeenCalledTimes(2);
});
it("POST enforces Origin/auth/bounds before one opaque owner call",async()=>{
 const req=(body:string,headers:Record<string,string>={})=>new NextRequest("http://localhost/api/browse/dirs",{method:"POST",body,headers});
 expect((await POST(req("{}",{origin:"https://evil.example"}))).status).toBe(403);
 vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN","private-web-token-1234567890123456789");expect((await POST(req("{}"))).status).toBe(401);vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");
 expect((await POST(req("x".repeat(4097)))).status).toBe(413);expect(remote).not.toHaveBeenCalled();
 remote.mockResolvedValueOnce(Response.json({path:"selected",command:"PRIVATE",token:"PRIVATE"}));
 const response=await POST(req('{"path":"opaque","command":"ignored"}'));expect(response.status).toBe(200);const body=await response.json();expect(JSON.stringify(body)).not.toContain("PRIVATE");
 expect(remote).toHaveBeenCalledOnce();const [url,options]=remote.mock.calls[0];expect(url).toContain("/browse/select-folder");expect(new TextDecoder().decode(options.body)).toBe('{"path":"opaque","command":"ignored"}');
 expect(options.headers["x-leafcode-host-folder"]).toBe("1");expect(options.headers.origin).toBeUndefined();
});
it("Host cancellation/old capability/malformed and oversized replies never produce a fake selection or native fallback",async()=>{
 const req=()=>new NextRequest("http://localhost",{method:"POST"});
 for(const [reply,status]of [[Response.json({cancelled:true,token:"PRIVATE"}),200],[Response.json({error:"old Host"},{status:404}),501],[Response.json({error:"unsupported"},{status:501}),501],[Response.json({path:123}),503],[new Response("x".repeat(256*1024+1)),503]] as const){
  remote.mockResolvedValueOnce(reply);const response=await POST(req());expect(response.status).toBe(status);const body=await response.json();expect(body.path).toBeUndefined();expect(JSON.stringify(body)).not.toContain("PRIVATE");if(status===501)expect(body.execution).toBe("not-started");
 }
 expect(remote).toHaveBeenCalledTimes(5);
});
it("POST unknown result is sanitized, never re-executed locally",async()=>{
 remote.mockRejectedValueOnce(new Error("PRIVATE"));const response=await POST(new NextRequest("http://localhost",{method:"POST",body:"{}"}));expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");expect(remote).toHaveBeenCalledOnce();
});

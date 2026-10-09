import{NextRequest}from"next/server";import{mkdtempSync,readdirSync,rmSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";import{beforeEach,afterEach,it,expect,vi}from"vitest";
import{POST}from"./route";
let root:string;const remote=vi.fn();
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-tts-bff-"));for(const[key,value]of Object.entries({LEAFCODE_PI_DATA_DIR:root,PI_CODING_AGENT_DIR:root,LEAFCODE_PI_PROCESS_ROLE:"next",LEAFCODE_PI_WEBUI_AUTH:"",LEAFCODE_PI_WEBUI_TOKEN:"",LEAFCODE_PI_BACKEND_TOKEN:"private-backend-token-1234567890123456789",LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:""}))vi.stubEnv(key,value);remote.mockReset();vi.stubGlobal("fetch",remote);});
afterEach(()=>{expect(readdirSync(root)).toEqual([]);vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});

const request=(body="{}",headers:Record<string,string>={})=>new NextRequest("http://localhost/api/tts/synthesize",{method:"POST",body,headers});
it("exact owner audio bytes and MIME replace private JSON envelope only after matching receipt",async()=>{
 remote.mockImplementationOnce(async(_url:string,options:RequestInit)=>Response.json({status:200,headers:{"set-cookie":"PRIVATE"},body:{audio:{contentType:"audio/mpeg",base64:"AAEC/w==",engineUrl:"PRIVATE"},operation:{id:new Headers(options.headers).get("x-leafcode-business-operation"),execution:"complete"},token:"PRIVATE"}}));
 const result=await POST(request('{"text":" 日本語 ","url":"ignored","voice":"ignored"}'));expect(result.status).toBe(200);expect(result.headers.get("content-type")).toBe("audio/mpeg");expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0,1,2,255]);expect(result.headers.get("set-cookie")).toBeNull();expect(new TextDecoder().decode(remote.mock.calls[0][1].body)).toBe('{"text":" 日本語 ","url":"ignored","voice":"ignored"}');
});
it("Origin/auth/body bounds precede owner; missing or mismatched ACK never emits audio",async()=>{
 expect((await POST(request("{}",{origin:"https://evil.invalid"}))).status).toBe(403);vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");expect((await POST(request())).status).toBe(401);vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");expect((await POST(request("x".repeat(16*1024+1)))).status).toBe(413);expect(remote).not.toHaveBeenCalled();
 for(const operation of[undefined,{id:"11111111-1111-1111-1111-111111111111",execution:"complete"}]){remote.mockResolvedValueOnce(Response.json({status:200,body:{audio:{contentType:"audio/wav",base64:"AQID"},operation}}));const r=await POST(request());expect(r.status).toBe(503);expect((await r.json()).execution).toBe("unknown");}
});
it("engine refusal, lost result and malformed media stay JSON error/unknown without retry",async()=>{
 remote.mockImplementationOnce(async(_url:string,options:RequestInit)=>Response.json({status:400,body:{error:"disabled",operation:{id:new Headers(options.headers).get("x-leafcode-business-operation"),execution:"complete"}}}));expect((await POST(request())).status).toBe(400);
 remote.mockRejectedValueOnce(new Error("PRIVATE"));const lost=await POST(request());expect(lost.status).toBe(503);expect((await lost.json()).execution).toBe("unknown");
 remote.mockResolvedValueOnce(Response.json({status:200,body:{audio:{contentType:"text/html",base64:"AQID"}}}));expect((await POST(request())).status).toBe(503);expect(remote).toHaveBeenCalledTimes(3);
});

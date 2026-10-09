import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readdirSync,readFileSync,symlinkSync } from "node:fs";
import { tmpdir } from "node:os";import{join,resolve}from"node:path";
import{afterEach,beforeEach,expect,it,vi}from"vitest";
import{dispatchJsonBusinessRequest}from"@backend-runtime/json-business/index";
import*as paths from"@backend-runtime/lib/browse-paths";import*as drives from"@backend-runtime/lib/browse-drives";
import*as icons from"@backend-runtime/lib/icon-file";import*as xdg from"@backend-runtime/lib/xdg-user-dirs";
const home=vi.hoisted(()=>({path:""}));
vi.mock("node:os",async original=>({...await original<typeof import("node:os")>(),homedir:()=>home.path}));
let root:string,project:string,outside:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"leafcode-browse-owner-"));project=join(root,"project");outside=join(root,"outside");mkdirSync(project);mkdirSync(outside);home.path=project;for(const [key,value]of Object.entries({LEAFCODE_PI_WEBUI_AUTH:"required",LEAFCODE_PI_PROCESS_ROLE:"backend",LEAFCODE_PI_BACKEND_RUNTIME:"attach",LEAFCODE_PI_DATA_DIR:join(root,"data"),PI_CODING_AGENT_DIR:join(root,"agent"),LEAFCODE_BROWSE_POWERSHELL:"__fixture_missing_powershell__"}))vi.stubEnv(key,value);vi.spyOn(paths,"browseAllowedRoots").mockReturnValue([project]);vi.spyOn(paths,"oneDriveRoots").mockReturnValue([]);drives.resetBrowseDrivesCache();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const request=async(route:string,method="GET",body?:unknown,path?:string,extra:Record<string,any>={})=>{const result=await dispatchJsonBusinessRequest({route,method,url:"http://localhost/api/"+route+(path?"?path="+encodeURIComponent(path):""),headers:{},authorized:true,...(body===undefined?{}:{body:new TextEncoder().encode(JSON.stringify(body))}),...extra});return{...result,body:result.body as Record<string,any>};};
it("denies development Next before cached probes/FS/DB/path adapters and native readers",async()=>{
 await drives.listBrowseDrives();vi.restoreAllMocks();vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");
 await expect(request("browse/dirs","GET",undefined,project)).rejects.toThrow(/owned by Backend/);
 for(const fn of[()=>paths.browseAllowedRoots(),()=>paths.oneDriveRoots(),()=>paths.resolveAllowedBrowsePath(project,{roots:[project]}),()=>icons.readIconFileAsDataUrl(join(project,"x.png")),()=>xdg.readXdgUserDirs()])expect(fn).toThrow(/owned by Backend/);
 await expect(drives.listBrowseDrives()).rejects.toThrow(/owned by Backend/);expect(readdirSync(root).sort()).toEqual(["outside","project"]);
});
it("canonical registered-root directory listing preserves dot-git, inside links, drives and denied parent",async()=>{
 mkdirSync(join(project,"assets"));mkdirSync(join(project,".git"));mkdirSync(join(project,".hidden"));symlinkSync(join(project,"assets"),join(project,"linked"),"junction");symlinkSync(outside,join(project,"escape"),"junction");
 vi.spyOn(drives,"listBrowseDrives").mockResolvedValue([{name:"fixture",path:project}]);
 const result=await request("browse/dirs","GET",undefined,project);expect(result.status).toBe(200);expect(result.body.parent).toBeNull();
 const names=result.body.entries.map((e:any)=>e.name);expect(names).toEqual([".git","assets","linked"]);expect((await request("browse/dirs","GET",undefined,join(project,"escape"))).status).toBe(403);
 const canonical=await request("browse/dirs","GET",undefined,join(project,"linked"));expect(canonical.body.path).toBe(join(project,"linked"));expect(canonical.body.entries).toEqual([]);
});
it("icon POST reads allowed bytes once, ignores caller executables/config/roots and leaves disk unchanged",async()=>{
 const file=join(project,"日本語.ico"),bytes=Buffer.from([0,0,1,0]);writeFileSync(file,bytes);
 const result=await request("browse/icon","POST",{path:file,command:"PRIVATE",roots:[outside],env:{LEAFCODE_PI_ICON_FILE:"PRIVATE"}});
 expect(result.status).toBe(200);expect(result.body).toEqual({icon:"data:image/x-icon;base64,AAABAA==",name:"日本語.ico"});expect(readFileSync(file)).toEqual(bytes);expect(readdirSync(root).sort()).toEqual(["outside","project"]);
});
it("auth/Origin/opaque body bounds reject before sampling and body interpretation; only Host owns dirs POST",async()=>{
 const spy=vi.spyOn(drives,"listBrowseDrives").mockResolvedValue([]);
 expect((await request("browse/dirs","GET",undefined,project,{authorized:false})).status).toBe(401);
 expect((await request("browse/icon","POST",{path:"ignored"},undefined,{headers:{origin:"https://evil.invalid"}})).status).toBe(403);
 expect((await request("browse/icon","POST",undefined,undefined,{body:new Uint8Array(256*1024+1)})).status).toBe(413);expect(spy).not.toHaveBeenCalled();
 expect((await request("browse/dirs","POST",{})).status).toBe(405);
});
it("relative/forged root/outside/symlink escape/UNC are denied without target reads",async()=>{
 const icon=join(outside,"outside.png");writeFileSync(icon,"PRIVATE");symlinkSync(outside,join(project,"escape"),"junction");
 for(const path of["relative",icon,join(project,"escape","outside.png"),"\\\\attacker\\share\\icon.png"]){expect((await request("browse/icon","POST",{path,roots:[outside]})).status).toBeGreaterThanOrEqual(400);}
 const realpath=vi.fn((path:string)=>path);expect(paths.resolveAllowedBrowsePath("\\\\attacker\\share",{platform:"win32",roots:["C:\\allowed"],realpath})).toBeNull();expect(realpath).toHaveBeenCalledTimes(1);expect(realpath).toHaveBeenCalledWith("C:\\allowed");expect(readFileSync(icon,"utf8")).toBe("PRIVATE");
});
it("loopback optional-auth mode remains usable without a WebUI token",async()=>{vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","");const result=await request("browse/icon","GET",undefined,project,{authorized:false});expect(result.status).toBe(200);expect(result.body.path).toBe(project);});
it("malformed owner success is unavailable and raw OS error text is not exposed",async()=>{
 const old=await import("@backend-runtime/json-business/handlers/browse/icon/route");
 vi.spyOn(old,"POST").mockResolvedValueOnce(Response.json({icon:"PRIVATE path",name:"x"}));
 const bad=await request("browse/icon","POST",{});expect(bad.status).toBe(503);expect(JSON.stringify(bad)).not.toContain("PRIVATE");
});

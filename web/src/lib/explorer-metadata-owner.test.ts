import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import * as store from "@backend-runtime/lib/store";
import { explorerControlUrl } from "@backend-runtime/lib/explorer-metadata";
beforeEach(()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_HOST_CONTROL_URL","http://127.0.0.1:32199");vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH","required");});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const read=(route:string,extra:Record<string,any>={})=>dispatchJsonBusinessRequest({route,method:"GET",url:"http://localhost/api/"+route+"?path=FORGED",headers:{},authorized:true,...extra});
it("resolves archived project/stored task paths at owner, without caller overrides or SDK hydration",async()=>{
  vi.spyOn(store,"getProject").mockReturnValue({id:"p",rootPath:"C:\\project",archived:true,token:"PRIVATE"} as any);
  vi.spyOn(store,"getTask").mockReturnValue({id:"t",directory:"C:\\task",kind:"code",token:"PRIVATE"} as any);
  for(const [route,path]of[["projects/p/explorer","C:\\project"],["tasks/t/explorer","C:\\task"]])expect((await read(route)).body).toEqual({path,controlUrl:"http://127.0.0.1:32199"});
});
it("missing IDs, Bot tasks and empty task workspaces remain refusals",async()=>{
  const task=vi.spyOn(store,"getTask").mockReturnValue(undefined);vi.spyOn(store,"getProject").mockReturnValue(undefined);
  expect((await read("projects/missing/explorer")).status).toBe(404);expect((await read("tasks/missing/explorer")).status).toBe(404);
  task.mockReturnValue({kind:"bot",directory:"C:\\bot"} as any);expect((await read("tasks/bot%3Ab/explorer")).status).toBe(403);
  task.mockReturnValue({kind:"code",directory:" "} as any);expect((await read("tasks/t/explorer")).status).toBe(404);
});
it("Next/unauthorized/invalid IDs refuse before store/control reads",async()=>{
  const get=vi.spyOn(store,"getProject");expect((await read("projects/p/explorer",{authorized:false})).status).toBe(401);
  for(const id of["a%2Fb","a%5Cb","..","%00","%xx"])expect((await read("projects/"+id+"/explorer")).status).toBe(404);
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(read("projects/p/explorer")).rejects.toThrow(/owned by Backend/);expect(explorerControlUrl).toThrow(/owned by Backend/);expect(get).not.toHaveBeenCalled();
});
it("never publishes a credential-bearing/control path/query capability",async()=>{
  vi.spyOn(store,"getProject").mockReturnValue({rootPath:"C:\\project"} as any);
  vi.stubEnv("LEAFCODE_PI_HOST_CONTROL_URL","http://user:PRIVATE@127.0.0.1:32199/?token=PRIVATE");
  const result=await read("projects/p/explorer");expect(result.status).toBe(503);expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

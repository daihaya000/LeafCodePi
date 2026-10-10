import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let root: string; const fetcher = vi.fn();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-mcp-ingress-")); for (const [key,value] of Object.entries({LEAFCODE_PI_DATA_DIR:root,PI_CODING_AGENT_DIR:root,LEAFCODE_PI_PROCESS_ROLE:"next",NODE_ENV:"development",LEAFCODE_PI_WEBUI_AUTH:"",LEAFCODE_PI_WEBUI_TOKEN:"",LEAFCODE_PI_BACKEND_TOKEN:"owner-private-token-1234567890123456789",LEAFCODE_PI_BACKEND_GENERATION:"",LEAFCODE_PI_BACKEND_GENERATION_FILE:""})) vi.stubEnv(key,value);fetcher.mockReset(); vi.stubGlobal("fetch",fetcher); });
afterEach(() => { expect(readdirSync(root)).toEqual([]);vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true}); });
const receipt = (init: RequestInit) => ({id:new Headers(init.headers).get("x-leafcode-business-operation"),execution:"complete"});

import { PATCH } from "./route";
const context = (name="remote")=>({params:Promise.resolve({name})});
it("PATCH forwards encoded selector and exact bytes in development; no business validation in Next",async()=>{fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:400,body:{error:"invalid",operation:receipt(init)}}));const body='{"enabled":false,"configPath":"opaque"}';expect((await PATCH(new Request("http://localhost",{method:"PATCH",body}),context("name/slash"))).status).toBe(400);expect(String(fetcher.mock.calls[0][0])).toContain("/mcp/name%2Fslash");expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(body);});
it("matching ACK returns redacted persisted enabled metadata only",async()=>{fetcher.mockImplementationOnce(async(_url,init)=>Response.json({status:200,body:{ok:true,name:"remote",enabled:false,servers:[],configPath:"PRIVATE",token:"PRIVATE",operation:receipt(init)}}));const response=await PATCH(new Request("http://localhost",{method:"PATCH",body:'{"enabled":false}'}),context());expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");});
it("owner exceptions and malformed successes remain uncertain without fallback or private exception text",async()=>{fetcher.mockRejectedValueOnce(new Error("PRIVATE"));expect((await PATCH(new Request("http://localhost",{method:"PATCH",body:"{}"}),context())).status).toBe(503);fetcher.mockResolvedValueOnce(Response.json({status:200,body:{ok:true}}));const response=await PATCH(new Request("http://localhost",{method:"PATCH",body:"{}"}),context());expect(response.status).toBe(503);expect(await response.text()).not.toContain("PRIVATE");expect(fetcher).toHaveBeenCalledTimes(2);});
it("PATCH bounds are independent of credential POST bounds",async()=>{expect((await PATCH(new Request("http://localhost",{method:"PATCH",body:"x".repeat(4097)}),context())).status).toBe(413);expect(fetcher).not.toHaveBeenCalled();});

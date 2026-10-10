import { beforeEach, expect, it, vi } from "vitest";
const relay=vi.hoisted(()=>vi.fn());vi.mock("@/lib/task-file-stream-relay",()=>({relayTaskFileStream:relay}));
import { GET,HEAD } from "./route";
beforeEach(()=>relay.mockReset());
it("GET and explicit HEAD forward unchanged opaque query, signals and selected task",async()=>{for(const method of["GET","HEAD"]){const req=new Request("http://localhost/api/tasks/t/message-image?messageId=m&partId=p",{method}),response=new Response(null,{status:206});relay.mockResolvedValue(response);expect(await (method==="HEAD"?HEAD:GET)(req,{params:Promise.resolve({id:"t"})})).toBe(response);expect(relay).toHaveBeenLastCalledWith(req,"tasks/t/message-image");}});
it("owner refusal never falls back to transcript or base64 in Next",async()=>{const response=Response.json({error:"Unavailable"},{status:503});relay.mockResolvedValue(response);expect(await GET(new Request("http://localhost"),{params:Promise.resolve({id:"t"})})).toBe(response);});

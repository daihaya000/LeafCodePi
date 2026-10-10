import { beforeEach, describe, expect, it, vi } from "vitest";
const relay=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/json-business-relay",()=>({relayJsonBusiness:relay}));
import { POST } from "./route";
beforeEach(()=>relay.mockReset());
describe("compact/abort transport-only route",()=>{
 it("passes the opaque original request to the owner and encodes only the parameter",async()=>{
  const req=new Request("http://localhost/api/tasks/x/compact/abort",{method:"POST",body:"not-json"});
  const response=Response.json({error:"owner refusal"},{status:409});relay.mockResolvedValue(response);
  expect(await POST(req,{params:Promise.resolve({id:"bot:fixture"})})).toBe(response);
  expect(relay).toHaveBeenCalledExactlyOnceWith(req,"tasks/bot%3Afixture/compact/abort");
 });
});

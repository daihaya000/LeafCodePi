import { beforeEach, describe, expect, it, vi } from "vitest";
const relay=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/json-business-relay",()=>({relayJsonBusiness:relay}));
import { POST } from "./route";
beforeEach(()=>relay.mockReset());
describe("fork transport-only route",()=>{
 it("encodes the parameter and passes the original request/response without domain interpretation",async()=>{
  const req=new Request("http://localhost/api/tasks/x/fork",{method:"POST",body:"not-json"});
  const result=Response.json({error:"owner refusal"},{status:409});relay.mockResolvedValue(result);
  expect(await POST(req,{params:Promise.resolve({id:"bot:fixture"})})).toBe(result);
  expect(relay).toHaveBeenCalledExactlyOnceWith(req,"tasks/bot%3Afixture/fork");
 });
});

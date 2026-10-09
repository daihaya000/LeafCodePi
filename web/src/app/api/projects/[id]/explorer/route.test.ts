import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const relay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/json-business-relay", () => ({ relayJsonBusiness: relay }));
import { GET, POST } from "./route";
it("relays ID-encoded Explorer metadata without local lookup/host IO", async () => {
  const response = new Response("owner"); relay.mockResolvedValueOnce(response);
  const request = new NextRequest("http://localhost/api/projects/x/explorer");
  expect(await GET(request, {params:Promise.resolve({id:"a/b ?"})})).toBe(response);
  expect(relay).toHaveBeenCalledWith(request, "projects/a%2Fb%20%3F/explorer");
});
it("never relays a remote Explorer launch", async () => {
  expect((await POST()).status).toBe(403); expect(relay).toHaveBeenCalledTimes(1);
});

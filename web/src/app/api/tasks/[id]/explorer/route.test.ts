import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const relay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/json-business-relay", () => ({ relayJsonBusiness: relay }));
import { GET } from "./route";
it("relays ID-encoded Explorer metadata without local lookup/host IO", async () => {
  const response = new Response("owner"); relay.mockResolvedValueOnce(response);
  const request = new NextRequest("http://localhost/api/tasks/x/explorer");
  expect(await GET(request, {params:Promise.resolve({id:"a/b ?"})})).toBe(response);
  expect(relay).toHaveBeenCalledWith(request, "tasks/a%2Fb%20%3F/explorer");
});

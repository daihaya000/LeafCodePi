import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ relayJsonBusiness: vi.fn() }));
vi.mock("@/lib/json-business-relay", () => ({ relayJsonBusiness: mocks.relayJsonBusiness }));

import { GET, PATCH } from "./route";

const params = { params: Promise.resolve({ id: "one/two" }) };

beforeEach(() => {
  mocks.relayJsonBusiness.mockReset();
  mocks.relayJsonBusiness.mockResolvedValue(new Response("relayed", { status: 200 }));
});

describe("/api/bots/[id]/intercom relay", () => {
  it("forwards GET without local inbox access", async () => {
    const request = new Request("http://localhost/api/bots/one%2Ftwo/intercom") as NextRequest;
    const response = await GET(request, params);

    expect(response.status).toBe(200);
    expect(mocks.relayJsonBusiness).toHaveBeenCalledExactlyOnceWith(request, "bots/one%2Ftwo/intercom");
  });

  it("forwards PATCH without local mutation or body interpretation", async () => {
    const request = new Request("http://localhost/api/bots/one%2Ftwo/intercom", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    }) as NextRequest;
    const response = await PATCH(request, params);

    expect(response.status).toBe(200);
    expect(mocks.relayJsonBusiness).toHaveBeenCalledExactlyOnceWith(request, "bots/one%2Ftwo/intercom");
  });
});

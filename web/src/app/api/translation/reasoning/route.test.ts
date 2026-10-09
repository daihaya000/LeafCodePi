import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const relay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/json-business-relay", () => ({ relayJsonBusiness: relay }));
import { POST } from "./route";
it("relays translation/reasoning unchanged without business parsing or fallback", async () => {
  const response = new Response("owner", { status: 503 }); relay.mockResolvedValueOnce(response);
  const request = new NextRequest("http://localhost/api/translation/reasoning", { method: "POST", body: "{invalid" });
  expect(await POST(request)).toBe(response); expect(relay).toHaveBeenCalledWith(request, "translation/reasoning");
});

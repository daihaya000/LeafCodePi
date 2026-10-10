import { expect, it, vi } from "vitest";
const relay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/json-business-relay", () => ({ relayJsonBusiness: relay }));
import { POST } from "./route";
it("relays link-preview unchanged without business parsing or fallback", async () => {
  const response = new Response("owner", { status: 503 }); relay.mockResolvedValueOnce(response);
  const request = new Request("http://localhost/api/link-preview", { method: "POST", body: "{invalid" });
  expect(await POST(request)).toBe(response); expect(relay).toHaveBeenCalledWith(request, "link-preview");
});

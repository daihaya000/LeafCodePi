import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const relay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/json-business-relay", () => ({ relayJsonBusiness: relay }));
import { GET } from "./route";
it("relays backend/tasks unchanged without business parsing or fallback", async () => {
  const response = new Response("owner", { status: 503 }); relay.mockResolvedValueOnce(response);
  const request = new NextRequest("http://localhost/api/backend/tasks", { method: "GET" });
  expect(await GET(request)).toBe(response); expect(relay).toHaveBeenCalledWith(request, "backend/tasks");
});

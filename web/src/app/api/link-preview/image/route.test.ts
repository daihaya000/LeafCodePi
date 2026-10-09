import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const relay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/task-file-stream-relay", () => ({ relayTaskFileStream: relay }));
import { GET } from "./route";
it("streams link-preview/image unchanged without business parsing or fallback", async () => {
  const response = new Response("owner", { status: 503 }); relay.mockResolvedValueOnce(response);
  const request = new NextRequest("http://localhost/api/link-preview/image", { method: "GET" });
  expect(await GET(request)).toBe(response); expect(relay).toHaveBeenCalledWith(request, "link-preview/image");
});

import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";
vi.mock("@/lib/host-http-client", () => ({ resolveHostControlUrl: () => "http://127.0.0.1:18775" }));
afterEach(() => vi.unstubAllGlobals());
it("forwards activity to the local Host without browser-supplied URLs or timestamps", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await POST()).status).toBe(204);
  expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18775/host/activity", expect.objectContaining({ method: "POST", cache: "no-store" }));
});
it("fails visibly when delivery fails so the browser can retry", async () => {
  vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
  expect((await POST()).status).toBe(502);
});

import { expect, it, vi } from "vitest";
import { forwardRuntimeEventStream } from "./backend-runtime-events";
const env = { LEAFCODE_PI_BACKEND_URL: "http://owner.invalid", LEAFCODE_PI_BACKEND_TOKEN: "private-test-token" };
it("proxies the owner stream without exposing private headers", async () => {
  const fetchImpl = vi.fn(async () => new Response('event: routine\ndata: {"ok":true}\n\n', { headers: { "content-type": "text/event-stream", "x-leafcode-backend-protocol": "1", authorization: "private-test-token" } }));
  const response = await forwardRuntimeEventStream(new AbortController().signal, { env, fetchImpl });
  expect(response.status).toBe(200); expect(await response.text()).toContain("event: routine");
  expect(response.headers.has("authorization")).toBe(false);
  expect(response.headers.has("x-leafcode-backend-protocol")).toBe(false);
  expect(fetchImpl.mock.calls.length).toBe(1);
});
it("owner failure and unexpected content never fall back to a local bus", async () => {
  for (const fetchImpl of [async () => { throw new Error("offline"); }, async () => new Response("{}")]) {
    expect((await forwardRuntimeEventStream(new AbortController().signal, { env, fetchImpl })).status).toBe(503);
  }
});
it("times out a stalled connection while respecting browser abort", async () => {
  const fetchImpl: typeof fetch = (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  expect((await forwardRuntimeEventStream(new AbortController().signal, { env, fetchImpl, timeoutMs: 10 })).status).toBe(503);
});

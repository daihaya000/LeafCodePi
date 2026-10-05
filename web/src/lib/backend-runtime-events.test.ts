import { expect, it, vi } from "vitest";
import { endOnUpstreamError, forwardRuntimeEventStream } from "./backend-runtime-events";
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
it("ends the browser stream cleanly when the Backend socket terminates mid-stream", async () => {
  const encoder = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(encoder.encode(": connected\n\n")); return; }
      controller.error(new TypeError("terminated"));
    },
  });
  const fetchImpl = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream", "x-leafcode-backend-protocol": "1" } }));
  const response = await forwardRuntimeEventStream(new AbortController().signal, { env, fetchImpl });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(": connected\n\n");
});
it("browser cancel releases the Backend stream", async () => {
  const cancel = vi.fn();
  const upstream = new ReadableStream<Uint8Array>({ pull() {}, cancel });
  const reader = endOnUpstreamError(upstream).getReader();
  await reader.cancel("browser closed");
  expect(cancel).toHaveBeenCalledWith("browser closed");
});

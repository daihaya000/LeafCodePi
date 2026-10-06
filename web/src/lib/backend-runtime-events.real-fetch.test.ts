// @vitest-environment node
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { forwardRuntimeEventStream } from "./backend-runtime-events";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

/**
 * Regression: the default fetch must accept `runtimeEventsDispatcher`. Node's built-in fetch rejects
 * an Agent from the `undici` package ("invalid onRequestStart method"), which turned every
 * runtime-event proxy into a 503 in production.
 */
it("connects to the owner with the default fetch and the long-lived dispatcher", async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "x-leafcode-backend-protocol": "1" });
    response.end(`event: task_dirty\ndata: {"auth":${JSON.stringify(request.headers.authorization)}}\n\n`);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const response = await forwardRuntimeEventStream(new AbortController().signal, {
    env: { LEAFCODE_PI_BACKEND_URL: `http://127.0.0.1:${port}`, LEAFCODE_PI_BACKEND_TOKEN: "private-test-token" },
    acceptEncoding: "gzip",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-encoding")).toBe("gzip");
  const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  expect(text).toBe('event: task_dirty\ndata: {"auth":"Bearer private-test-token"}\n\n');
});
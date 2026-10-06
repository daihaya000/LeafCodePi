// @vitest-environment node
import { createServer, get, ServerResponse, type IncomingMessage } from "node:http";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// The middleware `next start` installs in front of every response.
// @ts-expect-error -- Next ships this compiled module without type declarations.
import compression from "next/dist/compiled/compression";
import { installContentTypeStringHeader } from "./http-compression-fix";

async function fetchThroughCompression(
  respond: (res: ServerResponse) => void,
): Promise<{ encoding: string | undefined; body: Buffer }> {
  const compress = (compression as unknown as () => (req: IncomingMessage, res: ServerResponse, next: () => void) => void)();
  const server = createServer((req, res) => {
    compress(req, res, () => {});
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: "/", headers: { "accept-encoding": "gzip" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ encoding: res.headers["content-encoding"], body: Buffer.concat(chunks) }));
        res.on("error", reject);
      }).on("error", reject);
    });
  } finally {
    server.close();
  }
}

/** What Next's NodeNextResponse.appendHeader does with a route handler's headers. */
function respondLikeRouteHandler(res: ServerResponse, body: string) {
  res.statusCode = 200;
  res.setHeader("content-type", ["application/json"]);
  res.flushHeaders();
  res.write(body);
  (res as ServerResponse & { flush?: () => void }).flush?.();
  res.end();
}

describe("installContentTypeStringHeader", () => {
  const body = JSON.stringify({ tasks: Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, status: "idle" })) });

  it("lets compression gzip route handler JSON whose Content-Type was stored as an array", async () => {
    installContentTypeStringHeader();
    const response = await fetchThroughCompression((res) => respondLikeRouteHandler(res, body));
    expect(response.encoding).toBe("gzip");
    expect(gunzipSync(response.body).toString("utf8")).toBe(body);
    expect(response.body.byteLength).toBeLessThan(body.length / 4);
  });

  it("keeps multi-valued and non-Content-Type headers unchanged and installs once", () => {
    installContentTypeStringHeader();
    installContentTypeStringHeader();
    const res = new ServerResponse({ method: "GET" } as IncomingMessage);
    res.setHeader("content-type", ["text/plain"]);
    res.setHeader("set-cookie", ["a=1"]);
    res.setHeader("x-multi", ["a", "b"]);
    expect(res.getHeader("content-type")).toBe("text/plain");
    expect(res.getHeader("set-cookie")).toEqual(["a=1"]);
    expect(res.getHeader("x-multi")).toEqual(["a", "b"]);
  });
});

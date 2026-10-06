// @vitest-environment node
import { gunzipSync, createGunzip } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { acceptsGzip, gzipSseStream, sseResponse } from "./sse-response";

const encoder = new TextEncoder();

function pushStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  });
  return { stream, controller, cancel };
}

describe("acceptsGzip", () => {
  it("parses Accept-Encoding tokens and q=0", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0, br")).toBe(false);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe("gzipSseStream", () => {
  it("flushes every event so the client can decode it before the stream ends", async () => {
    const upstream = pushStream();
    const reader = gzipSseStream(upstream.stream).getReader();
    const gunzip = createGunzip();
    const decoded: string[] = [];
    gunzip.on("data", (chunk: Buffer) => decoded.push(chunk.toString("utf8")));
    const readUntil = async (text: string) => {
      while (!decoded.join("").includes(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("ended early");
        await new Promise<void>((resolve) => gunzip.write(value, () => resolve()));
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    upstream.controller.enqueue(encoder.encode("event: snapshot\ndata: {\"a\":1}\n\n"));
    await readUntil("{\"a\":1}");
    upstream.controller.enqueue(encoder.encode(": ping\n\n"));
    await readUntil(": ping");
    upstream.controller.close();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gunzip.write(value);
    }
    expect(decoded.join("")).toBe("event: snapshot\ndata: {\"a\":1}\n\n: ping\n\n");
  });

  it("cancels the upstream body when the client disconnects", async () => {
    const upstream = pushStream();
    const compressed = gzipSseStream(upstream.stream);
    await compressed.cancel("gone");
    expect(upstream.cancel).toHaveBeenCalledWith("gone");
  });
});

describe("sseResponse", () => {
  it("gzips for clients that accept it and compresses repeated snapshots", async () => {
    const upstream = pushStream();
    const response = sseResponse("gzip", upstream.stream);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    const event = `event: snapshot\ndata: ${JSON.stringify({ messages: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: "assistant", parts: [{ type: "text", text: "same text ".repeat(20) }] })) })}\n\n`;
    upstream.controller.enqueue(encoder.encode(event));
    upstream.controller.enqueue(encoder.encode(event));
    upstream.controller.close();
    const compressed = Buffer.from(await response.arrayBuffer());
    expect(gunzipSync(compressed).toString("utf8")).toBe(event + event);
    expect(compressed.byteLength).toBeLessThan(event.length / 5);
  });

  it("keeps the identity body for clients without gzip", async () => {
    const upstream = pushStream();
    const response = sseResponse(null, upstream.stream, { Pragma: "no-cache" });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("pragma")).toBe("no-cache");
    upstream.controller.enqueue(encoder.encode("data: x\n\n"));
    upstream.controller.close();
    expect(await response.text()).toBe("data: x\n\n");
  });
});

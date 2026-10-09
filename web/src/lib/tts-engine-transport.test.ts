import { createServer, type RequestListener, type Server } from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openStreamingTtsResponse, readTtsEngineTransportDiagnostics } from "@backend-runtime/lib/tts-engine-transport";
import { openTtsEngineAudio } from "@backend-runtime/lib/tts-synthesize";
const servers: Server[] = [];
beforeEach(() => vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"));
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  vi.unstubAllEnvs();
  expect(readTtsEngineTransportDiagnostics()).toEqual({ ttsEngineConnections: 0, ttsEnginePendingHeaders: 0, ttsEngineHeldBytes: 0, ttsEngineQueuedBytes: 0 });
});
async function engine(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function* chunks(response: Response) {
  const reader = response.body!.getReader();
  try { for (;;) { const part = await reader.read(); if (part.done) return; yield part.value; } }
  finally { reader.releaseLock(); }
}
it("streams exact native bytes in <=64KiB views, closes the connection at EOF", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 0x81);
  const url = await engine((req, res) => { expect(req.headers["accept-encoding"]).toBe("identity"); res.writeHead(200, { "content-type": "audio/wav", "content-length": data.length }); res.end(data); });
  const response = await openStreamingTtsResponse(url, { body: "{}" });
  let total = 0; for await (const bytes of chunks(response)) { expect(bytes.byteLength).toBeLessThanOrEqual(65536); expect(bytes.every((b: number) => b === 0x81)).toBe(true); total += bytes.byteLength; }
  expect(total).toBe(data.length);
});
it("an unread/canceled response bounds read-ahead and stops its producer", async () => {
  let sent = 0, done!: () => void;
  const stopped = new Promise<void>(r => done = r), chunk = Buffer.alloc(65536, 0x91);
  const url = await engine((_req, res) => {
    res.once("close", done); res.writeHead(200, { "content-type": "audio/wav" });
    const pump = () => { while (!res.destroyed && sent < 128 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) { res.once("drain", pump); return; } } if (!res.destroyed) res.end(); }; pump();
  });
  const response = await openStreamingTtsResponse(url, {}); await delay(30);
  const state = readTtsEngineTransportDiagnostics(); expect(state.ttsEngineHeldBytes).toBe(0); expect(state.ttsEngineQueuedBytes).toBeLessThanOrEqual(256 * 1024);
  await response.body!.cancel(); await stopped; expect(sent).toBeLessThan(8 * 1024 * 1024);
});
it("never follows redirects or accepts embedded credentials", async () => {
  let calls = 0; const url = await engine((_req, res) => { calls++; res.writeHead(302, { location: "/replayed" }); res.end("redirect"); });
  const response = await openStreamingTtsResponse(url, {}); expect(response.status).toBe(302); await response.body!.cancel(); expect(calls).toBe(1);
  await expect(openStreamingTtsResponse(url.replace("http://", "http://user:secret@"), {})).rejects.toThrow("Invalid"); expect(calls).toBe(1);
});
it("has a finite header wait without request replay", async () => {
  let calls = 0; const url = await engine(() => { calls++; });
  await expect(openStreamingTtsResponse(url, { timeoutMs: 30 })).rejects.toThrow("timeout");
  for (let i = 0; i < 20 && readTtsEngineTransportDiagnostics().ttsEngineConnections; i++) await delay(5);
  expect(calls).toBe(1);
});
it("the same absolute deadline covers a stalled body and releases its reader", async () => {
  const url = await engine((_req, res) => { res.writeHead(200, { "content-type": "audio/wav" }); res.write("x"); });
  const response = await openStreamingTtsResponse(url, { timeoutMs: 100 }), reader = response.body!.getReader();
  expect((await reader.read()).value!.byteLength).toBe(1);
  await expect(reader.read()).rejects.toThrow("unavailable"); reader.releaseLock();
});
const compressors: Array<[string, (input: Buffer) => Buffer]> = [
  ["gzip", input => gzipSync(input)], ["deflate", input => deflateSync(input)], ["br", input => brotliCompressSync(input)],
];
for (const [encoding, compress] of compressors) {
  it(`decodes ${encoding} with bounded chunks even if an engine ignores identity`, async () => {
    const plain = Buffer.alloc(512 * 1024, 0x82), packed = compress(plain);
    const url = await engine((_req, res) => { res.writeHead(200, { "content-encoding": encoding, "content-length": packed.length }); res.end(packed); });
    const response = await openStreamingTtsResponse(url, {}); let total = 0;
    for await (const chunk of chunks(response)) { expect(chunk.length).toBeLessThanOrEqual(65536); expect(chunk.every((b: number) => b === 0x82)).toBe(true); total += chunk.length; }
    expect(total).toBe(plain.length); expect(response.headers.get("content-encoding")).toBe(encoding);
  });
}
it("rejects malformed compressed bodies and unsupported encodings without residual IO", async () => {
  const url = await engine((req, res) => { res.writeHead(200, { "content-encoding": req.url === "/unsupported" ? "unknown" : "gzip" }); res.end("invalid"); });
  await expect(openStreamingTtsResponse(url + "/unsupported", {})).rejects.toThrow("Unsupported");
  for (let i = 0; i < 20 && readTtsEngineTransportDiagnostics().ttsEngineConnections; i++) await delay(5);
  const response = await openStreamingTtsResponse(url, {}); await expect(response.arrayBuffer()).rejects.toThrow("unavailable");
});
it("preserves real Voicevox query/synthesis input through the native public transport", async () => {
  const calls: string[] = []; let starts = 0;
  const url = await engine(async (req, res) => {
    calls.push(req.url!);
    if (req.url!.startsWith("/audio_query?")) { res.setHeader("content-type", "application/json"); res.end('{"fixture":"日本語"}'); return; }
    const body: Buffer[] = []; for await (const bytes of req) body.push(bytes);
    expect(JSON.parse(Buffer.concat(body).toString())).toEqual({ fixture: "日本語" });
    res.setHeader("content-type", "audio/wav"); res.end(Buffer.from([0, 1, 2, 255]));
  });
  const response = await openTtsEngineAudio(" 日本語 ", url, "style-42", { streaming: true, onStart: () => starts++ });
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 2, 255]); expect(starts).toBe(1);
  expect(calls).toEqual(["/audio_query?text=%E6%97%A5%E6%9C%AC%E8%AA%9E&speaker=42", "/synthesis?speaker=42"]);
});
it("cancels a rejected Voicevox query and never starts synthesis", async () => {
  let calls = 0; const url = await engine((_req, res) => { calls++; res.writeHead(403); res.write("rejected"); });
  await expect(openTtsEngineAudio("日本語", url, "1", { streaming: true })).rejects.toThrow("audio_query"); expect(calls).toBe(1);
});
it("handles bodyless replies and truncated content without open sockets", async () => {
  const url = await engine((req, res) => { if (req.url === "/empty") { res.writeHead(204); res.end(); } else { res.writeHead(200, { "content-length": "100" }); res.write("short"); res.destroy(); } });
  const empty = await openStreamingTtsResponse(url + "/empty", {}); expect(empty.status).toBe(204); expect(empty.body).toBeNull();
  await expect(openStreamingTtsResponse(url, {}).then(r => r.arrayBuffer())).rejects.toThrow();
  for (let i = 0; i < 20 && readTtsEngineTransportDiagnostics().ttsEngineConnections; i++) await delay(5);
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { EventEmitter } from "node:events";
import { streamProviderLoginEvents, readProviderLoginTransportDiagnostics } from "./provider-login-events.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
async function fixture(t, options = {}) {
  const token = randomBytes(32).toString("hex"), server = createBackendServer({ token, isReady: () => true, ...options });
  t.after(() => closeBackend(server)); const address = await listenBackend(server, 0);
  return { base: `http://127.0.0.1:${address.port}/internal/provider-login-events/fixture?sessionId=s`, headers: { authorization: `Bearer ${token}`, "x-leafcode-backend-protocol": "1", "x-leafcode-business-origin": "http://localhost", "x-leafcode-business-host": "localhost", "x-leafcode-business-authorized": "1" } };
}
test("login event transport rejects auth/protocol/method/context/readiness before owner subscription", async t => {
  let calls = 0; const f = await fixture(t, { providerLoginEventsAction: async () => { calls++; throw Error("Must not run"); } });
  assert.equal((await fetch(f.base)).status, 401);
  assert.equal((await fetch(f.base, { headers: { ...f.headers, "x-leafcode-backend-protocol": "2" } })).status, 409);
  assert.equal((await fetch(f.base, { method: "POST", headers: f.headers })).status, 405);
  assert.equal((await fetch(f.base, { headers: { ...f.headers, "x-leafcode-business-origin": "bad" } })).status, 400);
  assert.equal(calls, 0);
  const unavailable = await fixture(t, { isReady: () => false, providerLoginEventsAction: async () => { calls++; } });
  assert.equal((await fetch(unavailable.base, { headers: unavailable.headers })).status, 503); assert.equal(calls, 0);
});
test("login event transport streams owner bytes with trusted identity and no browser credentials", async t => {
  const f = await fixture(t, { providerLoginEventsAction: async input => {
    assert.equal(input.route, "fixture"); assert.equal(new URL(input.url).searchParams.get("sessionId"), "s");
    assert.equal(input.headers.authorization, undefined); assert.equal(input.headers.cookie, undefined); assert.equal(input.authorized, true);
    return new Response('event: started\ndata: {"sessionId":"s"}\n\nevent: done\ndata: {"ok":true}\n\n', { headers: { "content-type": "text/event-stream", "set-cookie": "PRIVATE" } });
  } });
  const response = await fetch(f.base, { headers: { ...f.headers, cookie: "PRIVATE" } });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /event-stream/); assert.equal(response.headers.get("set-cookie"), null);
  assert.match(await response.text(), /event: started[\s\S]*event: done/);
});
test("preaborted and invalid sources release bodies/readers before touching sockets", async () => {
  for (const preabort of [true, false]) {
    let cancels = 0; const c = new AbortController(); if (preabort) c.abort();
    const source = new Response(new ReadableStream({ cancel() { cancels++; } }), { status: preabort ? 200 : 503, headers: { "content-type": "text/event-stream" } });
    const response = { destroyed: false, writeHead() {}, end() {}, flushHeaders() { assert.fail("No headers before abort"); } };
    await streamProviderLoginEvents(response, source, c.signal); assert.equal(cancels, 1); assert.equal(source.body.locked, false);
    assert.deepEqual(readProviderLoginTransportDiagnostics(), { readers: 0, drainWaiters: 0 });
  }
});
test("native drain deadline and overlapping close/abort release exactly one waiter and reader", async () => {
  for (const close of [false, true]) {
    const c = new AbortController(), res = new EventEmitter(); let canceled = 0;
    Object.assign(res, { destroyed: false, writableLength: 0, writeHead() {}, flushHeaders() {}, write() { return false; }, destroy() { this.destroyed = true; }, end() {} });
    res.on("close", () => c.abort());
    const source = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { canceled++; } }), { headers: { "content-type": "text/event-stream" } });
    const work = streamProviderLoginEvents(res, source, c.signal, { stallMs: 20 });
    await delay(5); if (close) res.emit("close"); await work;
    assert.equal(canceled, 1); assert.equal(source.body.locked, false); assert.equal(res.listenerCount("drain"), 0); assert.equal(res.listenerCount("close"), 1);
    assert.deepEqual(readProviderLoginTransportDiagnostics(), { readers: 0, drainWaiters: 0 });
  }
});
test("browser disconnect cancels only the owner subscriber, including idle streams", async t => {
  let canceled = 0;
  const f = await fixture(t, { providerLoginEventsAction: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': connected\n\n')); }, cancel() { canceled++; } }), { headers: { "content-type": "text/event-stream" } }) });
  const controller = new AbortController(), response = await fetch(f.base, { headers: f.headers, signal: controller.signal });
  await response.body.getReader().read(); controller.abort();
  const until = Date.now() + 2000; while (!canceled && Date.now() < until) await delay(10);
  assert.equal(canceled, 1);
});

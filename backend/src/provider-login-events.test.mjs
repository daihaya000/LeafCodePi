import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
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
test("browser disconnect cancels only the owner subscriber, including idle streams", async t => {
  let canceled = 0;
  const f = await fixture(t, { providerLoginEventsAction: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': connected\n\n')); }, cancel() { canceled++; } }), { headers: { "content-type": "text/event-stream" } }) });
  const controller = new AbortController(), response = await fetch(f.base, { headers: f.headers, signal: controller.signal });
  await response.body.getReader().read(); controller.abort();
  const until = Date.now() + 2000; while (!canceled && Date.now() < until) await delay(10);
  assert.equal(canceled, 1);
});

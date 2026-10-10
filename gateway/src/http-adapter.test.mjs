import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { nodeHttpHandler } from "./http-adapter.mjs";
import { createGatewayServer } from "./server.mjs";
import { createDispatcher } from "./router.mjs";
import { setResponseCookie } from "../../shared/http-cookie.mjs";
import compression from "../../web/node_modules/next/dist/compiled/compression/index.js";

async function serve(t, dispatch) {
  const server = createServer(nodeHttpHandler(dispatch));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Node adapter preserves URL/query/body/headers and does not abort after normal body completion", async t => {
  let signal;
  const base = await serve(t, async request => {
    signal = request.signal;
    const body = await request.text(); await delay(15);
    return Response.json({ url: request.url, method: request.method, cookie: request.headers.get("cookie"), body, aborted: signal.aborted });
  });
  const response = await fetch(base + "/api/x?q=%2F&token=not-consumed", { method: "POST", headers: { cookie: "a=b", "content-type": "text/plain" }, body: "body bytes" });
  assert.deepEqual(await response.json(), { url: base + "/api/x?q=%2F&token=not-consumed", method: "POST", cookie: "a=b", body: "body bytes", aborted: false });
  await delay(10); assert.equal(signal.aborted, false);
});

test("gateway preserves legacy bind URL/forwarded defaults and incoming browser Host authority", async t => {
  const saved = process.env.LEAFCODE_PI_WEBUI_AUTH; delete process.env.LEAFCODE_PI_WEBUI_AUTH;
  t.after(() => { if (saved === undefined) delete process.env.LEAFCODE_PI_WEBUI_AUTH; else process.env.LEAFCODE_PI_WEBUI_AUTH = saved; });
  const server = createGatewayServer([{ route: "/api/echo", methods: ["GET"], load: async () => ({ GET: request => Response.json({ url: request.url, headers: Object.fromEntries(request.headers) }) }) }], { hostname: "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const result = await new Promise((resolve, reject) => {
    const call = httpRequest(`http://127.0.0.1:${port}/api/echo?q=%2F`, { headers: { host: "browser.invalid:8443", "x-forwarded-proto": "https,http", cookie: ["first=one", "second=two"] } }, async response => {
      try { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
    });
    call.on("error", reject); call.end();
  });
  assert.equal(result.url, `https://localhost:${port}/api/echo?q=%2F`);
  assert.equal(result.headers.host, "browser.invalid:8443"); assert.equal(result.headers["x-forwarded-host"], "browser.invalid:8443");
  assert.equal(result.headers["x-forwarded-port"], String(port)); assert.equal(result.headers["x-forwarded-proto"], "https,http");
  assert.equal(result.headers["x-forwarded-for"], "127.0.0.1"); assert.equal(result.headers.cookie, "first=one; second=two");
});

test("multiple Set-Cookie headers survive HTTP; HEAD suppresses body and cancels its producer", async t => {
  let cancelled = 0;
  const base = await serve(t, () => {
    const response = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled++; } }), { headers: { "content-type": "application/octet-stream", "x-test": "value" } });
    setResponseCookie(response, "first", "a"); setResponseCookie(response, "second", "b"); return response;
  });
  const response = await fetch(base, { method: "HEAD" });
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get("x-test"), "value"); assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(cancelled, 1);
});

test("SSE delivers a first event before completion and disconnect aborts request and cancels source", async t => {
  let signal, cancelled = false;
  const base = await serve(t, request => {
    signal = request.signal;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  });
  const controller = new AbortController();
  const response = await fetch(base, { signal: controller.signal });
  const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/);
  controller.abort(); await reader.cancel().catch(() => {});
  for (let i = 0; i < 100 && (!signal.aborted || !cancelled); i++) await delay(5);
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

test("abort during upload reaches handler and incomplete input is not replayed", async t => {
  let signal, entered = 0;
  const base = await serve(t, async request => { entered++; signal = request.signal; await request.text().catch(() => {}); return new Response(); });
  const request = httpRequest(base, { method: "POST", headers: { "content-length": 999999 } });
  request.on("error", () => {}); request.write("first");
  for (let i = 0; i < 100 && !signal; i++) await delay(5);
  request.destroy();
  for (let i = 0; i < 100 && !signal?.aborted; i++) await delay(5);
  assert.equal(signal.aborted, true); assert.equal(entered, 1);
});

test("slow reader exerts backpressure, disconnect releases a drain waiter", async t => {
  let pulls = 0, cancelled = false;
  const base = await serve(t, () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 })));
  const request = httpRequest(base); request.end();
  const [response] = await once(request, "response"); response.pause(); await delay(60);
  assert.ok(pulls < 256, `Unbounded buffering: ${pulls}`);
  response.destroy(); request.destroy();
  for (let i = 0; i < 100 && !cancelled; i++) await delay(5);
  assert.equal(cancelled, true);
});

test("router prioritizes static segments, decodes params once, retains implicit methods and rejects unknown API", async t => {
  const routes = [
    { route: "/api/items/[id]", methods: ["GET"], load: async () => ({ GET: async (_request, context) => Response.json(await context.params) }) },
    { route: "/api/items/list", methods: ["POST"], load: async () => ({ POST: () => Response.json({ static: true }) }) },
  ];
  const base = await serve(t, createDispatcher(routes, { gate: () => ({}) }));
  assert.deepEqual(await (await fetch(base + "/api/items/a%252Fb")).json(), { id: "a%2Fb" });
  assert.deepEqual(await (await fetch(base + "/api/items/list", { method: "POST" })).json(), { static: true });
  assert.equal((await fetch(base + "/api/items/list")).status, 405);
  const options = await fetch(base + "/api/items/x", { method: "OPTIONS" }); assert.equal(options.status, 204); assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal((await fetch(base + "/api/items/x", { method: "HEAD" })).status, 200);
  assert.equal((await fetch(base + "/api/missing")).status, 404);
  assert.equal((await fetch(base + "/api/items/%FF")).status, 400);
});

test("canonical redirect precedes auth, preserves query/body/Refresh and never refreshes cookies", async t => {
  let gates = 0, loaded = 0;
  const base = await serve(t, createDispatcher([{ route: "/api/tasks", methods: ["GET"], load: () => { loaded++; throw new Error("Redirect must not admit a handler"); } }], {
    gate: () => { gates++; return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) }; },
  }));
  const location = "/api/tasks?q=%2F&cursor=a%20b&cursor=keep";
  for (const method of ["GET", "HEAD", "POST"]) for (const headers of [{}, { cookie: "leafcode-pi-token=finite-browser" }]) {
    const response = await fetch(base + "/api/tasks/?q=%2F&cursor=a%20b&cursor=keep", { method, headers, redirect: "manual" });
    assert.equal(response.status, 308); assert.equal(response.headers.get("location"), location);
    assert.equal(response.headers.get("refresh"), `0;url=${location}`);
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(location)));
    for (const name of ["content-type", "vary", "set-cookie", "content-encoding"]) assert.equal(response.headers.get(name), null, name);
    assert.equal(await response.text(), method === "HEAD" ? "" : location);
  }
  assert.equal(gates, 0); assert.equal(loaded, 0);
  assert.equal((await fetch(base + "/api/tasks", { redirect: "manual" })).status, 401); assert.equal(gates, 1);
});

test("compression negotiation matches original Next middleware including wildcard/identity/q/duplicates", async t => {
  const body = JSON.stringify({ text: "x".repeat(2048) }), headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
  const gateway = await serve(t, () => new Response(body, { headers }));
  const compress = compression();
  const reference = createServer((request, response) => compress(request, response, () => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.end(body);
  }));
  await new Promise(resolve => reference.listen(0, "127.0.0.1", resolve));
  t.after(async () => { reference.closeAllConnections(); await new Promise(resolve => reference.close(resolve)); });
  const next = `http://127.0.0.1:${reference.address().port}`;
  const tokens = ["gzip", "deflate", "identity", "*", "br", "GZIP", "gzip;q=0", "gzip;q=0.5", "deflate;q=0", "deflate;q=0.5", "identity;q=0", "identity;q=0.5", "*;q=0", "*;q=0.5", "gzip;q=invalid", "gzip;q=-1", "gzip;q=2", "gzip;level=1;q=0.5"];
  const values = new Set(["", ...tokens, "gzip;Q=0.5", "gzip ; q=0.5 ;extra=1", ";bad", "gzip;q=0.5;q=0", ...tokens.flatMap(a => tokens.map(b => `${a}, ${b}`))]);
  for (const value of values) {
    const observations = [];
    for (const base of [next, gateway]) {
      const response = await fetch(base, { headers: { "accept-encoding": value } });
      observations.push({ body: await response.text(), encoding: response.headers.get("content-encoding"), vary: response.headers.get("vary"), length: response.headers.get("content-length") });
    }
    assert.deepEqual(observations[1], observations[0], `Accept-Encoding: ${value}`);
  }
  t.diagnostic(`${values.size} original compression middleware observations, decoded bytes and headers equal`);
});

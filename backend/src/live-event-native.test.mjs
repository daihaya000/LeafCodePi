import test from "node:test";
import assert from "node:assert/strict";
import { createBackendServer, listenBackend, closeBackend } from "./server.mjs";
import { JSON_BUSINESS_HEADERS as wire } from "../../shared/json-business-contract.mjs";
const token = "fixture" + "x".repeat(32);
const headers = { authorization: "Bearer " + token, "x-leafcode-backend-protocol": "1", [wire.origin]: "http://localhost", [wire.host]: "localhost", [wire.authorized]: "1" };
test("private SSE gates token/protocol/method/client/readiness, opaque cursor and abort cleanup", async t => {
 const calls = []; let cancelled = 0, signal;
 const server = createBackendServer({ token, isReady: () => true, liveEventsAction: input => {
  calls.push(input); signal = input.signal;
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream", "x-accel-buffering": "no", "cache-control": "no-store", "set-cookie": "PRIVATE" } });
 }});
 t.after(() => closeBackend(server));
 const address = await listenBackend(server, 0), base = "http://127.0.0.1:" + address.port + "/internal/live-events/bots/events";
 for (const [options, status] of [[{},401], [{headers:{authorization:"Bearer "+token}},409], [{method:"POST",headers},405], [{headers:{...headers,[wire.origin]:"bad"}},400]]) {
  const response = await fetch(base, options); assert.equal(response.status,status); await response.body.cancel();
 }
 assert.equal(calls.length,0);
 const response = await fetch(base+"?delta=1", {headers:{...headers,"last-event-id":"opaque:old"}});
 assert.equal(response.status,200); assert.equal(response.headers.get("x-accel-buffering"),"no"); assert.equal(response.headers.get("set-cookie"),null);
 assert.equal(calls[0].headers["last-event-id"],"opaque:old"); assert.match(calls[0].url,/\?delta=1$/);
 const reader = response.body.getReader(); await reader.read(); await reader.cancel();
 for(let i=0;i<100&&!signal.aborted;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(signal.aborted,true); assert.equal(cancelled,1);
});
test("not-ready and absent event owner fail503 with no file-stream fallback", async t => {
 const server=createBackendServer({token,isReady:()=>false,liveEventsAction:()=>assert.fail("not ready"),taskFileStreamAction:()=>assert.fail("no fallback")});
 t.after(()=>closeBackend(server)); const a=await listenBackend(server,0);
 const response=await fetch("http://127.0.0.1:"+a.port+"/internal/live-events/bots/events",{headers});assert.equal(response.status,503);await response.body.cancel();
});

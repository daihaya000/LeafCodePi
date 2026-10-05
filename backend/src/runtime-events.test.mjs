import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createBackendServer, closeBackend } from "./server.mjs";
import { streamRuntimeEvents } from "./runtime-events.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_RUNTIME_EVENTS_PATH } from "../../shared/backend-protocol.mjs";

test("owner Bot/routine events cross HTTP and disconnect releases both subscriptions", async (t) => {
  const owner = new EventEmitter();
  const server = createBackendServer({ token: "test-token-that-is-at-least-32-chars", isReady: () => true,
    subscribeRuntimeEvents: (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeBackend(server));
  const url = `http://127.0.0.1:${server.address().port}${BACKEND_RUNTIME_EVENTS_PATH}`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: "Bearer test-token-that-is-at-least-32-chars", [BACKEND_PROTOCOL_HEADER]: "1" } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read(); // connected comment; neither event is generated in the Web process.
  owner.emit("event", { event: "routine", payload: { botId: "bot", ok: true } });
  owner.emit("event", { event: "snapshot", payload: { eventType: "code_session_changed" } });
  owner.emit("event", { event: "task_dirty", payload: { taskId: "task-1", reason: "prompt_accepted" } });
  let text = "";
  while (!text.includes("task_dirty") || !text.includes("code_session_changed")) {
    text += new TextDecoder().decode((await reader.read()).value);
  }
  assert.match(text, /event: routine/);
  assert.match(text, /event: snapshot/);
  assert.match(text, /event: task_dirty/);
  assert.match(text, /task-1/);
  await reader.cancel();
  for (let i = 0; i < 20 && owner.listenerCount("event") > 0; i++) await delay(10);
  assert.equal(owner.listenerCount("event"), 0);
});

/** Socket-like response whose write() reports a full buffer, as Windows does for any burst over 16 KiB. */
function fakeResponse() {
  const response = new EventEmitter();
  Object.assign(response, {
    writableLength: 0, destroyed: false, chunks: [],
    writeHead() {}, flushHeaders() {},
    write(chunk) { response.chunks.push(chunk); response.writableLength += chunk.length; return false; },
    destroy() { response.destroyed = true; response.emit("close"); },
  });
  return response;
}

test("a full socket buffer alone does not drop a draining consumer", () => {
  const owner = new EventEmitter();
  const response = fakeResponse();
  let clock = 0;
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 60_000, maxBufferedBytes: 1024 * 1024, stallMs: 1000, now: () => clock });
  for (let i = 0; i < 200; i++) owner.emit("event", { event: "task_dirty", payload: { taskId: `task-${i}`, reason: "x".repeat(100) } });
  assert.equal(response.destroyed, false);
  assert.equal(owner.listenerCount("event"), 1);
  response.writableLength = 0;
  response.emit("drain");
  clock = 5000;
  owner.emit("event", { event: "routine", payload: { ok: true } });
  assert.equal(response.destroyed, false);
  response.destroy();
  assert.equal(owner.listenerCount("event"), 0);
});

test("an over-cap backlog drops the transport and releases the subscription", () => {
  const owner = new EventEmitter();
  const response = fakeResponse();
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 60_000, maxBufferedBytes: 4096 });
  for (let i = 0; i < 100 && !response.destroyed; i++) owner.emit("event", { event: "routine", payload: { text: "x".repeat(100) } });
  assert.equal(response.destroyed, true);
  assert.equal(owner.listenerCount("event"), 0);
});

test("a consumer that never drains is dropped on the next heartbeat after the stall window", async () => {
  const owner = new EventEmitter();
  const response = fakeResponse();
  let clock = 0;
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 5, stallMs: 1000, now: () => clock });
  await delay(20);
  assert.equal(response.destroyed, false);
  clock = 1000;
  for (let i = 0; i < 50 && !response.destroyed; i++) await delay(5);
  assert.equal(response.destroyed, true);
  assert.equal(owner.listenerCount("event"), 0);
});

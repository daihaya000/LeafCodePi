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

test("undrained sockets skip further event payloads until drain", () => {
  const owner = new EventEmitter();
  const response = fakeResponse();
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 60_000, maxBufferedBytes: 1024 * 1024, stallMs: 60_000 });
  // connected write already returned false, so the socket is undrained before any event.
  const afterConnect = response.chunks.length;
  assert.ok(afterConnect >= 1);
  owner.emit("event", { event: "task_dirty", payload: { taskId: "a" } });
  owner.emit("event", { event: "routine", payload: { ok: true } });
  assert.equal(response.chunks.length, afterConnect, "backpressure skips while undrained");
  response.writableLength = 0;
  response.emit("drain");
  // The deferred task wake is replayed on drain; the routine frame stays dropped.
  assert.equal(response.chunks.length, afterConnect + 1);
  assert.match(response.chunks.at(-1), /"taskId":"a"/);
  assert.doesNotMatch(response.chunks.at(-1), /routine/);
  response.writableLength = 0;
  response.emit("drain");
  owner.emit("event", { event: "task_dirty", payload: { taskId: "c" } });
  assert.equal(response.chunks.length, afterConnect + 2);
  assert.match(response.chunks.at(-1), /"taskId":"c"/);
  response.destroy();
  assert.equal(owner.listenerCount("event"), 0);
});

test("request close destroys the transport and releases the subscription", () => {
  const owner = new EventEmitter();
  const response = fakeResponse();
  const request = new EventEmitter();
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 60_000, request });
  assert.equal(owner.listenerCount("event"), 1);
  request.emit("close");
  assert.equal(response.destroyed, true);
  assert.equal(owner.listenerCount("event"), 0);
});

test("byte-cap drop still works when writes keep succeeding past the high-water mark", () => {
  const owner = new EventEmitter();
  const response = new EventEmitter();
  Object.assign(response, {
    writableLength: 0, destroyed: false, chunks: [],
    writeHead() {}, flushHeaders() {},
    write(chunk) { response.chunks.push(chunk); response.writableLength += chunk.length; return true; },
    destroy() { response.destroyed = true; response.emit("close"); },
  });
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 60_000, maxBufferedBytes: 4096 });
  for (let i = 0; i < 100 && !response.destroyed; i++) {
    owner.emit("event", { event: "routine", payload: { text: "x".repeat(100) } });
  }
  assert.equal(response.destroyed, true);
  assert.equal(owner.listenerCount("event"), 0);
});

test("task wakes deferred under backpressure coalesce per task and replay once on drain", () => {
  const owner = new EventEmitter();
  const response = fakeResponse();
  streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
    { heartbeatMs: 60_000, stallMs: 60_000, includeStream: true, maxDeferredTaskWakes: 2 });
  const afterConnect = response.chunks.length;
  for (let i = 0; i < 5; i++) owner.emit("event", { event: "task_dirty", payload: { taskId: "a", reason: `r${i}` } });
  owner.emit("event", { event: "task_stream", payload: { taskId: "a", reason: "stream" } });
  owner.emit("event", { event: "task_dirty", payload: { taskId: "overflow" } });
  assert.equal(response.chunks.length, afterConnect);
  response.writableLength = 0;
  response.emit("drain");
  assert.equal(response.chunks.length, afterConnect + 1);
  const replay = response.chunks.at(-1);
  assert.equal(replay.match(/event: task_dirty/g)?.length, 1, "one dirty per task");
  assert.match(replay, /"reason":"r4"/, "newest wake wins");
  assert.match(replay, /event: task_stream/);
  assert.doesNotMatch(replay, /overflow/, "bounded: the safety-net poll covers overflow");
  response.destroy();
});

test("streaming-text wakes are only sent to consumers that opt in", () => {
  const owner = new EventEmitter();
  const make = (includeStream) => {
    const response = new EventEmitter();
    Object.assign(response, {
      writableLength: 0, destroyed: false, chunks: [], writeHead() {}, flushHeaders() {},
      write(chunk) { response.chunks.push(chunk); return true; },
      destroy() { response.destroyed = true; response.emit("close"); },
    });
    streamRuntimeEvents(response, (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
      { heartbeatMs: 60_000, includeStream });
    return response;
  };
  const browser = make(false);
  const hub = make(true);
  owner.emit("event", { event: "task_stream", payload: { taskId: "t", reason: "stream" } });
  assert.equal(browser.chunks.some((chunk) => chunk.includes("task_stream")), false);
  assert.equal(hub.chunks.some((chunk) => chunk.includes("task_stream")), true);
  browser.destroy();
  hub.destroy();
});

test("the HTTP route opts into streaming wakes with ?stream=1", async (t) => {
  const owner = new EventEmitter();
  const server = createBackendServer({ token: "test-token-that-is-at-least-32-chars", isReady: () => true,
    subscribeRuntimeEvents: (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeBackend(server));
  const url = `http://127.0.0.1:${server.address().port}${BACKEND_RUNTIME_EVENTS_PATH}?stream=1`;
  const response = await fetch(url, { headers: { authorization: "Bearer test-token-that-is-at-least-32-chars", [BACKEND_PROTOCOL_HEADER]: "1" } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  owner.emit("event", { event: "task_stream", payload: { taskId: "task-9", reason: "stream" } });
  let text = "";
  while (!text.includes("task-9")) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: task_stream/);
  await reader.cancel();
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { readJsonBody, JsonBodyReadError } from "./json-body.mjs";

function request(headers = {}) {
  const value = new EventEmitter();
  value.headers = headers;
  value.paused = false;
  value.pause = () => { value.paused = true; };
  return value;
}

function assertNoListeners(value) {
  for (const event of ["data", "end", "aborted", "error", "close"]) {
    assert.equal(value.listenerCount(event), 0, event);
  }
}

function isBodyError(reason) {
  return (error) => error instanceof JsonBodyReadError && error.reason === reason;
}

test("JSON body accepts an exact byte limit and UTF-8 characters split across chunks", async () => {
  const value = request();
  const bytes = Buffer.from(JSON.stringify({ text: "日本語🌿" }));
  const reading = readJsonBody(value, bytes.length);
  for (const byte of bytes) value.emit("data", Buffer.from([byte]));
  value.emit("end");
  value.emit("close");
  assert.deepEqual(await reading, { ok: true, value: { text: "日本語🌿" } });
  assert.equal(value.paused, false);
  assertNoListeners(value);
});

test("empty and malformed completed bodies stay distinct from interrupted transport", async () => {
  for (const [text, reason] of [["", "empty"], ["{", "invalid"]]) {
    const value = request();
    const reading = readJsonBody(value);
    if (text) value.emit("data", Buffer.from(text));
    value.emit("end");
    value.emit("close");
    assert.deepEqual(await reading, { ok: false, reason });
    assertNoListeners(value);
  }
});

test("declared overflow pauses immediately without collecting any body data", async () => {
  const value = request({ "content-length": "5" });
  const rejected = assert.rejects(readJsonBody(value, 4), isBodyError("too-large"));
  assert.equal(value.paused, true);
  assert.equal(value.listenerCount("data"), 0);
  assert.equal(value.listenerCount("end"), 0);
  // A peer reset can still emit error before close after the 413 is scheduled.
  value.emit("error", new Error("reset"));
  value.emit("close");
  await rejected;
  assertNoListeners(value);
});

test("chunked overflow drops buffered chunks and cannot resume parsing later data", async () => {
  const value = request();
  const rejected = assert.rejects(readJsonBody(value, 4), isBodyError("too-large"));
  value.emit("data", Buffer.from("1234"));
  value.emit("data", Buffer.from("5"));
  assert.equal(value.paused, true);
  assert.equal(value.listenerCount("data"), 0);
  value.emit("data", Buffer.from("{}"));
  value.emit("end");
  value.emit("close");
  await rejected;
  assertNoListeners(value);
});

test("aborted -> error -> close settles once without an unhandled stream error", async () => {
  const value = request();
  const rejected = assert.rejects(readJsonBody(value), isBodyError("incomplete"));
  value.emit("data", Buffer.from("{"));
  value.emit("aborted");
  assert.equal(value.listenerCount("data"), 0);
  value.emit("error", new Error("ECONNRESET"));
  value.emit("close");
  await rejected;
  assertNoListeners(value);
});

test("a close without end or error rejects rather than leaving a pending promise", async () => {
  const value = request();
  const rejected = assert.rejects(readJsonBody(value), isBodyError("incomplete"));
  value.emit("data", Buffer.from("{}"));
  value.emit("close");
  await rejected;
  assertNoListeners(value);
});

test("transport errors reject and remove remaining listeners on close", async () => {
  const value = request();
  const rejected = assert.rejects(readJsonBody(value), isBodyError("incomplete"));
  value.emit("error", new Error("private error detail"));
  value.emit("close");
  await rejected;
  assertNoListeners(value);
});

test("an already aborted request rejects while still observing queued error/close", async () => {
  for (const field of ["aborted", "destroyed"]) {
    const value = request();
    value[field] = true;
    const rejected = assert.rejects(readJsonBody(value), isBodyError("incomplete"));
    value.emit("error", new Error("queued reset"));
    value.emit("close");
    await rejected;
    assertNoListeners(value);
  }
});

test("invalid limits cannot accidentally disable the byte cap", () => {
  for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => readJsonBody(request(), limit), RangeError);
});

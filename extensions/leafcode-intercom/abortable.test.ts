import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { waitWithAbort } from "./abortable.ts";

test("pre-aborted waits never start an operation", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(waitWithAbort(async () => { started = true; }, controller.signal), /Cancelled/);
  assert.equal(started, false);
});

test("abort releases only one wait on a shared operation and cleans listeners", async () => {
  const controller = new AbortController();
  let resolveShared!: (value: number) => void;
  const shared = new Promise<number>((resolve) => { resolveShared = resolve; });
  const cancelled = waitWithAbort(() => shared, controller.signal);
  const other = waitWithAbort(() => shared);
  controller.abort();
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  resolveShared(42);
  assert.equal(await other, 42);
});

test("settled and synchronously failed operations remove abort listeners", async () => {
  const controller = new AbortController();
  assert.equal(await waitWithAbort(async () => 1, controller.signal), 1);
  await assert.rejects(waitWithAbort(() => { throw new Error("failed"); }, controller.signal), /failed/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

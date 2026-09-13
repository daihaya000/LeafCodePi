import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseWriter } from "./sse-writer";

describe("createSseWriter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not throw when a heartbeat fires after the stream is closed", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    const sse = createSseWriter(controller);
    sse.startHeartbeat(15_000);
    sse.close();
    vi.advanceTimersByTime(30_000);
    await stream.cancel();
    assert.equal(sse.closed, true);
  });

  it("ignores enqueue after cleanup without closing twice", () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    const sse = createSseWriter(controller);
    sse.cleanup();
    sse.send("snapshot", { ok: true });
    sse.close();
    sse.close();
    assert.equal(sse.closed, true);
    void stream.cancel();
  });

  it("runs cleanup subscribers once", () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    const sse = createSseWriter(controller);
    let calls = 0;
    sse.onCleanup(() => {
      calls += 1;
    });
    sse.close();
    sse.cleanup();
    assert.equal(calls, 1);
    void stream.cancel();
  });

  it("runs a cleanup subscriber registered after cleanup immediately", () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    const sse = createSseWriter(controller);
    sse.cleanup();

    let calls = 0;
    sse.onCleanup(() => {
      calls += 1;
    });
    expect(calls).toBe(1);

    sse.close();
    expect(calls).toBe(1);
    void stream.cancel();
  });

  it("reports serialization and enqueue timings when requested", () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    const timings: string[] = [];
    const sse = createSseWriter(controller, {
      onTiming: ({ phase }) => timings.push(phase),
    });

    sse.send("snapshot", { ok: true });

    assert.deepEqual(timings, [
      "sse.json:snapshot",
      "sse.encode:snapshot",
      "sse.enqueue:snapshot",
    ]);
    void stream.cancel();
  });
});

export type SseWriter = {
  readonly closed: boolean;
  send(event: string, data: unknown): void;
  startHeartbeat(intervalMs?: number): void;
  onCleanup(fn: () => void): void;
  cleanup(): void;
  close(): void;
};

export type SseWriterTiming = {
  phase: string;
  durationMs: number;
};

export type SseWriterOptions = {
  onTiming?: (timing: SseWriterTiming) => void;
};

export function createSseWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
  options: SseWriterOptions = {},
): SseWriter {
  const encoder = new TextEncoder();
  const reportTiming = (phase: string, startedAt: number) => {
    if (!options.onTiming) return;
    options.onTiming({
      phase,
      durationMs: Math.max(0, performance.now() - startedAt),
    });
  };
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanupFns: Array<() => void> = [];
  const runCleanup = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* ignore subscriber errors during teardown */
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    for (const fn of cleanupFns.splice(0)) runCleanup(fn);
  };

  const enqueue = (bytes: Uint8Array) => {
    if (closed) return;
    try {
      controller.enqueue(bytes);
    } catch {
      cleanup();
    }
  };

  const writer: SseWriter = {
    get closed() {
      return closed;
    },
    send(event: string, data: unknown) {
      const jsonStartedAt = options.onTiming ? performance.now() : 0;
      const json = JSON.stringify(data);
      reportTiming(`sse.json:${event}`, jsonStartedAt);
      const encodeStartedAt = options.onTiming ? performance.now() : 0;
      const bytes = encoder.encode(`event: ${event}\ndata: ${json}\n\n`);
      reportTiming(`sse.encode:${event}`, encodeStartedAt);
      const enqueueStartedAt = options.onTiming ? performance.now() : 0;
      enqueue(bytes);
      reportTiming(`sse.enqueue:${event}`, enqueueStartedAt);
    },
    startHeartbeat(intervalMs = 15_000) {
      if (closed || heartbeat) return;
      heartbeat = setInterval(() => {
        enqueue(encoder.encode(`: ping\n\n`));
      }, intervalMs);
    },
    onCleanup(fn: () => void) {
      if (closed) {
        runCleanup(fn);
        return;
      }
      cleanupFns.push(fn);
    },
    cleanup,
    close() {
      cleanup();
      try {
        controller.close();
      } catch {
        /* already closed or cancelled */
      }
    },
  };
  return writer;
}

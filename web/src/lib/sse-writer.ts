export type SseWriter = {
  readonly closed: boolean;
  send(event: string, data: unknown): void;
  startHeartbeat(intervalMs?: number): void;
  onCleanup(fn: () => void): void;
  cleanup(): void;
  close(): void;
};

export function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>): SseWriter {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanupFns: Array<() => void> = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    for (const fn of cleanupFns) {
      try {
        fn();
      } catch {
        /* ignore subscriber errors during teardown */
      }
    }
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
      enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    startHeartbeat(intervalMs = 15_000) {
      if (closed || heartbeat) return;
      heartbeat = setInterval(() => {
        enqueue(encoder.encode(`: ping\n\n`));
      }, intervalMs);
    },
    onCleanup(fn: () => void) {
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

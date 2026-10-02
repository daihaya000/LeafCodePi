import { sseReconnectDelayMs } from "./sse-reconnect";

/**
 * One `/api/bots/events` EventSource per tab, shared by every consumer.
 *
 * After the cutover that route proxies the Backend's runtime-event SSE, so a source per
 * component multiplies browser connections (HTTP/1.1 allows only ~6 per origin, and every
 * open task pane already holds one) and Backend streams. The hub owns the connection,
 * JSON parsing, reconnect/backoff and the open/error notifications the callers use to
 * decide whether their idle polls can stretch.
 */

export type BotsEventsHandlers = {
  /** Event name → handler. Malformed JSON still dispatches with `undefined`. */
  events?: Record<string, (payload: unknown) => void>;
  onOpen?: () => void;
  onError?: () => void;
};

type BotsEventsEntry = {
  events: Record<string, (payload: unknown) => void>;
  onOpen?: () => void;
  onError?: () => void;
};

const entries = new Set<BotsEventsEntry>();
const attached = new Map<string, EventListener>();
let source: EventSource | null = null;
let sourceOpen = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

function notifyOpen() {
  for (const entry of [...entries]) {
    try {
      entry.onOpen?.();
    } catch {
      // One consumer's callback must not break the shared connection.
    }
  }
}

function notifyError() {
  for (const entry of [...entries]) {
    try {
      entry.onError?.();
    } catch {
      // One consumer's callback must not break the shared connection.
    }
  }
}

function dispatch(name: string, event: Event) {
  let payload: unknown;
  try {
    payload = JSON.parse(String((event as MessageEvent).data));
  } catch {
    payload = undefined;
  }
  for (const entry of [...entries]) {
    const handler = entry.events[name];
    if (!handler) continue;
    try {
      handler(payload);
    } catch {
      // A consumer's handler must not break the shared connection.
    }
  }
}

/** Attach only the event names some current subscriber needs. */
function syncListeners() {
  if (!source) return;
  const wanted = new Set<string>();
  for (const entry of entries) {
    for (const name of Object.keys(entry.events)) wanted.add(name);
  }
  for (const [name, listener] of attached) {
    if (wanted.has(name)) continue;
    if (typeof source.removeEventListener === "function") source.removeEventListener(name, listener);
    attached.delete(name);
  }
  for (const name of wanted) {
    if (attached.has(name)) continue;
    const listener: EventListener = (event) => dispatch(name, event);
    source.addEventListener(name, listener);
    attached.set(name, listener);
  }
}

function scheduleReconnect() {
  if (retryTimer !== null || entries.size === 0) return;
  reconnectAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    openSource();
  }, sseReconnectDelayMs(reconnectAttempt));
}

function openSource() {
  if (source || entries.size === 0 || typeof EventSource === "undefined") return;
  let next: EventSource;
  try {
    next = new EventSource(`/api/bots/events?epoch=${Date.now()}`);
  } catch {
    // An unavailable transport leaves the consumers' idle polls as the fallback.
    return;
  }
  source = next;
  attached.clear();
  next.addEventListener("open", () => {
    if (source !== next) return;
    reconnectAttempt = 0;
    sourceOpen = true;
    notifyOpen();
  });
  // A failed initial connection is terminal for EventSource (it will not retry), and a
  // dropped established one is cheap to redo ourselves, so always close and back off.
  next.addEventListener("error", () => {
    if (source !== next) return;
    next.close();
    source = null;
    sourceOpen = false;
    attached.clear();
    notifyError();
    scheduleReconnect();
  });
  syncListeners();
}

/**
 * Subscribe to the shared runtime-event stream. Returns an unsubscribe; the last one
 * closes the EventSource, so a tab with no consumers holds no connection.
 */
export function subscribeBotsEvents(handlers: BotsEventsHandlers): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const entry: BotsEventsEntry = { events: handlers.events ?? {}, onOpen: handlers.onOpen, onError: handlers.onError };
  entries.add(entry);
  openSource();
  syncListeners();
  if (sourceOpen) {
    try {
      entry.onOpen?.();
    } catch {
      // A late subscriber's callback must not break the shared connection.
    }
  }
  return () => {
    entries.delete(entry);
    if (entries.size > 0) {
      syncListeners();
      return;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    reconnectAttempt = 0;
    sourceOpen = false;
    const current = source;
    source = null;
    attached.clear();
    current?.close();
  };
}

/** Test helper: drop shared connection state between cases. */
export function resetBotsEventsHubForTests(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  reconnectAttempt = 0;
  sourceOpen = false;
  const current = source;
  source = null;
  attached.clear();
  entries.clear();
  current?.close();
}

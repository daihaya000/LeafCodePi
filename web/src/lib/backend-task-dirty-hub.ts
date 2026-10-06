import { backendBaseUrl, type BackendEnv } from "@/lib/backend-client";
import { runtimeEventsDispatcher, runtimeEventsFetch } from "@/lib/backend-runtime-events";
import {
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
  BACKEND_RUNTIME_EVENTS_PATH,
} from "@shared/backend-protocol.mjs";

/**
 * Process-local hub: one Backend runtime-events SSE feeds every remote task stream's dirty wake.
 * Falls back silently when the Backend is unreachable; callers keep their idle poll safety net.
 *
 * The hub opts into `task_stream` (throttled streaming-text wakes, reason `"stream"`) so cutover
 * task streams can forward the included latest-message delta without a Backend detail read. Listeners
 * that only care about lifecycle changes should ignore `reason === "stream"`.
 *
 * Wakes are not replayed across a reconnect, so every listener gets one `reason: "resync"` wake
 * when the stream (re)connects: a prompt accepted while the hub was down then shows at once
 * instead of after the 30s idle safety-net poll. `isBackendTaskDirtyConnected()` lets callers keep
 * a short safety-net poll while the hub is down.
 */

export type BackendTaskDirtyPayload = {
  taskId: string;
  reason?: string;
  /** Compact message/status delta piggybacked on throttled stream wakes. */
  delta?: Record<string, unknown>;
};
/** Streaming-text wake reason; lifecycle-only consumers ignore it. */
export const BACKEND_TASK_STREAM_REASON = "stream";
/** Synthetic wake sent to every listener after the hub (re)connects. */
export const BACKEND_TASK_RESYNC_REASON = "resync";

type DirtyListener = (payload: BackendTaskDirtyPayload) => void;

const listeners = new Map<string, Set<DirtyListener>>();
let pump: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let connected = false;

/** True while the shared Backend runtime-events stream is attached and delivering wakes. */
export function isBackendTaskDirtyConnected(): boolean {
  return connected;
}

function clearReconnect() {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function disconnect() {
  clearReconnect();
  pump?.abort();
  pump = null;
  reconnectAttempt = 0;
  connected = false;
}

/** Wake every listener once; used after (re)connect because missed wakes are not replayed. */
function notifyAll(reason: string) {
  for (const taskId of [...listeners.keys()]) notify({ taskId, reason });
}

function notify(payload: BackendTaskDirtyPayload) {
  const set = listeners.get(payload.taskId);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(payload);
    } catch {
      // A single viewer's wake must not take the hub down.
    }
  }
}

function parseSseChunk(buffer: string): { rest: string; events: Array<{ event: string; data: string }> } {
  const events: Array<{ event: string; data: string }> = [];
  let rest = buffer;
  while (true) {
    const boundary = rest.indexOf("\n\n");
    if (boundary < 0) break;
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":") || line.length === 0) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }
  return { rest, events };
}

async function runPump(signal: AbortSignal, env: BackendEnv, fetchImpl: typeof fetch) {
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) throw new Error("missing backend token");
  // Connection establishment only — once headers arrive the body streams until abort.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  let response: Response;
  try {
    // `stream=1` opts into throttled streaming-text wakes (`task_stream`).
    response = await fetchImpl(`${backendBaseUrl(env)}${BACKEND_RUNTIME_EVENTS_PATH}?stream=1`, {
      headers: {
        authorization: `Bearer ${token}`,
        [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
      },
      signal: AbortSignal.any([signal, deadline.signal]),
      cache: "no-store",
      dispatcher: runtimeEventsDispatcher,
    } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
  if (
    !response.ok
    || !response.body
    || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)
    || !response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("backend dirty stream unavailable");
  }
  reconnectAttempt = 0;
  connected = true;
  // Anything that changed while the hub was down produced wakes nobody saw.
  if (!signal.aborted) notifyAll(BACKEND_TASK_RESYNC_REASON);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.events) {
      if (frame.event !== "task_dirty" && frame.event !== "task_stream") continue;
      try {
        const payload = JSON.parse(frame.data) as BackendTaskDirtyPayload;
        if (typeof payload?.taskId !== "string" || !payload.taskId) continue;
        notify(frame.event === "task_stream"
          ? { ...payload, reason: BACKEND_TASK_STREAM_REASON }
          : payload);
      } catch {
        // Malformed frames are dropped; the next dirty or idle poll recovers.
      }
    }
  }
}

function scheduleReconnect(env: BackendEnv, fetchImpl: typeof fetch) {
  if (listeners.size === 0 || pump) return;
  clearReconnect();
  const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    ensurePump(env, fetchImpl);
  }, delay);
  reconnectTimer.unref?.();
}

function ensurePump(env: BackendEnv = process.env, fetchImpl: typeof fetch = runtimeEventsFetch) {
  if (pump || listeners.size === 0) return;
  const controller = new AbortController();
  pump = controller;
  void runPump(controller.signal, env, fetchImpl)
    .catch(() => undefined)
    .finally(() => {
      if (pump === controller) {
        pump = null;
        connected = false;
      }
      if (listeners.size > 0 && !controller.signal.aborted) scheduleReconnect(env, fetchImpl);
    });
}

/**
 * Subscribe to Backend task-dirty wakes for one task id.
 * Returns an unsubscribe that drops the listener and tears the shared SSE down when idle.
 */
export function subscribeBackendTaskDirty(
  taskId: string,
  listener: DirtyListener,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch } = {},
): () => void {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(listener);
  ensurePump(options.env, options.fetchImpl);
  return () => {
    const current = listeners.get(taskId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(taskId);
    if (listeners.size === 0) disconnect();
  };
}

/**
 * Wake this process's viewers of one task without waiting for the Backend's notice. The prompt
 * route calls it once the owner accepted a send, so the sender's stream re-reads at once even if
 * the Backend wake is delayed or lost; the shared read dedupes it with the Backend wake.
 */
export function wakeBackendTaskListeners(taskId: string, reason = "local") {
  notify({ taskId, reason });
}

/** Test helper: drop shared connection state between cases. */
export function resetBackendTaskDirtyHubForTests() {
  disconnect();
  listeners.clear();
}

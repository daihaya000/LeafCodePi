import type { NestedToolCallDto, UiMessage } from "@/lib/types";
import { toolResultText } from "@/lib/pi/messages";

/**
 * Calls a running tool (a codemode script) makes, collected from `tool_execution_*` events that carry
 * `parentToolCallId`. The SDK records the same calls on the tool result only when the tool finishes,
 * so this is what a running card can show. Arguments are never kept.
 */
export type LiveNestedCalls = Map<string, { calls: NestedToolCallDto[]; startedAtMs: Map<string, number> }>;

const MAX_CALLS_PER_PARENT = 256;
const MAX_PARENTS = 64;
const MAX_ERROR_CHARS = 500;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Records one nested `tool_execution_start` / `tool_execution_end`. Returns true when the event was a
 * nested one (so callers keep it away from the top-level per-call maps), false otherwise.
 */
export function trackNestedToolEvent(
  store: LiveNestedCalls,
  event: { type: string; [key: string]: unknown },
  nowMs: number = Date.now(),
): boolean {
  const parentId = text(event.parentToolCallId);
  if (!parentId) return false;
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end" && event.type !== "tool_execution_update") {
    return false;
  }
  const id = text(event.toolCallId);
  if (!id || event.type === "tool_execution_update") return true;

  if (event.type === "tool_execution_start") {
    let entry = store.get(parentId);
    if (!entry) {
      // Bound the store: a parent whose end never arrived must not pin memory for the whole session.
      if (store.size >= MAX_PARENTS) store.delete(store.keys().next().value!);
      entry = { calls: [], startedAtMs: new Map() };
      store.set(parentId, entry);
    }
    if (entry.calls.length >= MAX_CALLS_PER_PARENT || entry.calls.some((call) => call.id === id)) return true;
    entry.calls.push({ id, name: text(event.toolName) || "tool", status: "unfinished" });
    entry.startedAtMs.set(id, nowMs);
    return true;
  }

  const entry = store.get(parentId);
  const index = entry ? entry.calls.findIndex((call) => call.id === id) : -1;
  if (!entry || index < 0) return true;
  const call = entry.calls[index]!;
  const isError = event.isError === true;
  const started = entry.startedAtMs.get(id);
  const error = isError ? toolResultText(event.result).slice(0, MAX_ERROR_CHARS) : "";
  entry.calls[index] = {
    id: call.id,
    name: call.name,
    status: isError ? "error" : "ok",
    ...(started === undefined ? {} : { durationMs: Math.max(0, nowMs - started) }),
    ...(error ? { error } : {}),
  };
  entry.startedAtMs.delete(id);
  return true;
}

const storeBySession = new WeakMap<object, LiveNestedCalls>();

/**
 * The live store of a session. Keyed by the session object so the snapshot projection, which already
 * receives the session, needs no extra argument; it is released with the session.
 */
export function nestedCallsStoreFor(session: object | undefined, create = false): LiveNestedCalls | undefined {
  if (!session || typeof session !== "object") return undefined;
  let store = storeBySession.get(session);
  if (!store && create) {
    store = new Map();
    storeBySession.set(session, store);
  }
  return store;
}

/** Puts the live calls on the running tool parts they belong to. Other messages are returned as they are. */
export function applyLiveNestedCalls(messages: UiMessage[], store: LiveNestedCalls): UiMessage[] {
  const remaining = new Set([...store.keys()].filter((id) => (store.get(id)?.calls.length ?? 0) > 0));
  if (remaining.size === 0) return messages;
  let result: UiMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0 && remaining.size > 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    let parts: UiMessage["parts"] | undefined;
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "tool" || !remaining.has(part.callID)) return;
      if (part.state.status !== "running" && part.state.status !== "pending") return;
      remaining.delete(part.callID);
      parts ??= message.parts.slice();
      parts[partIndex] = { ...part, state: { ...part.state, nestedCalls: store.get(part.callID)!.calls.map((call) => ({ ...call })) } };
    });
    if (!parts) continue;
    result ??= messages.slice();
    result[index] = { ...message, parts };
  }
  return result ?? messages;
}

/** The calls recorded for one running tool call, oldest first. Empty when there are none. */
export function liveNestedCallsFor(store: LiveNestedCalls | undefined, parentId: string): NestedToolCallDto[] {
  return store?.get(parentId)?.calls ?? [];
}

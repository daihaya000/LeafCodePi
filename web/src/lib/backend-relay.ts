/**
 * Reading the WebUI's own routes from the Backend instead of the in-process store.
 *
 * The rule is the ownership itself, not a switch: a process that owns the runtime serves its own
 * store, and a client (after the cutover) reads the owner's view. A client that cannot read the
 * Backend reports the failure rather than serving its local copy (`relayFallbackAllowed`).
 */
import {
  expectedBackendGeneration,
  isBackendGenerationCompatible,
  readBackendBots,
  readBackendHealth,
  readBackendTasks,
} from "@/lib/backend-client";
import { botsWithCodeSessionCounts } from "@backend-core/bot-session-counts.mjs";
// The ownership rule lives with the runtime guards; the relay only reads it.
import { localRuntimeBlocked, webOwnsRuntime } from "@/lib/pi/runtime-ownership";

/** How long a compatibility probe is reused; the relay must not probe the Backend per request. */
export const RELAY_COMPATIBILITY_TTL_MS = 5_000;

let compatibilityCache: { expected: string; at: number; compatible: boolean } | null = null;

/** Test seam: forget the cached probe. */
export function resetBackendRelayCompatibilityCache(): void {
  compatibilityCache = null;
}

/**
 * Whether this Web process still owns the Pi runtime: re-exported so existing callers keep one import.
 */
export { webOwnsRuntime };

/**
 * Whether a route may fall back to its in-process read when the relay cannot answer.
 *
 * Before the cutover the WebUI still owns the store, so a relay miss is a fallback. After the
 * cutover the Backend owns it: serving the local copy would hide a broken owner and can show state
 * the owner never confirmed, so the route reports the failure instead.
 */
export function relayFallbackAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return !localRuntimeBlocked(env);
}

/**
 * Whether this process may read its data from the Backend: only a process that does not own the
 * runtime relays (the owner serves its own store), and only when the generation the Host pinned
 * matches the one the Backend is running. A generation mismatch means the two disagree about the
 * running SDK/extensions, so the relay stays on the in-process path instead of trusting it.
 * An unpinned generation has nothing to compare, so it is compatible.
 */
export async function backendRelayCompatible(
  options: {
    env?: Record<string, string | undefined>;
    fetchHealth?: typeof readBackendHealth;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (relayFallbackAllowed(env)) return false;
  const expected = expectedBackendGeneration(env);
  if (!expected) return true;
  const now = (options.now ?? Date.now)();
  if (compatibilityCache?.expected === expected && now - compatibilityCache.at < RELAY_COMPATIBILITY_TTL_MS) {
    return compatibilityCache.compatible;
  }
  const health = await (options.fetchHealth ?? readBackendHealth)({ env });
  const compatible = health.ok && isBackendGenerationCompatible(expected, health.body.runtimeGeneration);
  compatibilityCache = { expected, at: now, compatible };
  return compatible;
}

/**
 * The rows `listTasks(includeArchived, kind)` would return, read from the Backend.
 *
 * Returns null when the relay is off or the Backend cannot answer. The caller decides what a miss
 * means: an owner keeps its in-process result, a client reports the failure (see
 * `relayFallbackAllowed`). A task row without a `kind` counts as a Code task, exactly like the store.
 */
export async function relayTaskRows(
  options: {
    includeArchived: boolean;
    kind: string;
    env?: Record<string, string | undefined>;
    fetchTasks?: typeof readBackendTasks;
    fetchHealth?: typeof readBackendHealth;
  },
): Promise<Array<Record<string, unknown>> | null> {
  const env = options.env ?? process.env;
  if (!(await backendRelayCompatible({ env, fetchHealth: options.fetchHealth }))) return null;
  const read = options.fetchTasks ?? readBackendTasks;
  const result = await read();
  if (!result.ok) return null;
  const tasks = Array.isArray(result.body?.tasks) ? result.body.tasks : [];
  return tasks.filter((task) => {
    if (options.kind !== "all" && (task?.kind ?? "code") !== options.kind) return false;
    return options.includeArchived || task?.status !== "archived";
  });
}

/**
 * The Bot list `listBots()` plus its running-session counts, read from the Backend.
 *
 * Returns null when the relay is off or the Backend cannot answer, so the caller keeps its
 * in-process result. Both reads must succeed: a partial list would report wrong counts.
 */
export async function relayBotList(
  options: {
    env?: Record<string, string | undefined>;
    fetchBots?: typeof readBackendBots;
    fetchTasks?: typeof readBackendTasks;
    fetchHealth?: typeof readBackendHealth;
  } = {},
): Promise<Array<Record<string, unknown>> | null> {
  const env = options.env ?? process.env;
  if (!(await backendRelayCompatible({ env, fetchHealth: options.fetchHealth }))) return null;
  const [botsResult, tasksResult] = await Promise.all([
    (options.fetchBots ?? readBackendBots)(),
    (options.fetchTasks ?? readBackendTasks)(),
  ]);
  if (!botsResult.ok || !tasksResult.ok) return null;
  const bots = Array.isArray(botsResult.body?.bots) ? botsResult.body.bots : [];
  const tasks = Array.isArray(tasksResult.body?.tasks) ? tasksResult.body.tasks : [];
  return botsWithCodeSessionCounts(bots, tasks) as Array<Record<string, unknown>>;
}

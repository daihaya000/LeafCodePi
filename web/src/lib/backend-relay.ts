/**
 * Pre-cutover relay switch for the WebUI's own routes.
 *
 * The relay is off by default: the Web process still owns the store, so a route must only read from
 * the Backend when the operator explicitly asks for it. When it is on, a route serves the Backend's
 * data and falls back to its in-process path if the Backend cannot answer — the fallback is the
 * safety net before the cutover, and disappears with the old path in the last phase.
 */
import {
  expectedBackendGeneration,
  isBackendGenerationCompatible,
  readBackendBots,
  readBackendHealth,
  readBackendTasks,
} from "@/lib/backend-client";
import { botsWithCodeSessionCounts } from "@backend-core/bot-session-counts.mjs";

/** Values that turn the relay on; anything else leaves it off. */
const RELAY_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/** How long a compatibility probe is reused; the relay must not probe the Backend per request. */
export const RELAY_COMPATIBILITY_TTL_MS = 5_000;

let compatibilityCache: { expected: string; at: number; compatible: boolean } | null = null;

/** Test seam: forget the cached probe. */
export function resetBackendRelayCompatibilityCache(): void {
  compatibilityCache = null;
}

export function isBackendRelayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return RELAY_ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RELAY ?? "").trim().toLowerCase());
}

/**
 * Whether the relay may use this Backend at all: enabled, and the same runtime generation the Host
 * pinned for this WebUI. A generation mismatch means the WebUI and the Backend disagree about the
 * running SDK/extensions, so the relay stays on the in-process path instead of writing to it.
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
  if (!isBackendRelayEnabled(env)) return false;
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
 * Returns null when the relay is off or the Backend cannot answer, so the caller keeps its
 * in-process result. A task row without a `kind` counts as a Code task, exactly like the store.
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

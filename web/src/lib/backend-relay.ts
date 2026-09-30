/**
 * Pre-cutover relay switch for the WebUI's own routes.
 *
 * The relay is off by default: the Web process still owns the store, so a route must only read from
 * the Backend when the operator explicitly asks for it. When it is on, a route serves the Backend's
 * data and falls back to its in-process path if the Backend cannot answer — the fallback is the
 * safety net before the cutover, and disappears with the old path in the last phase.
 */
import { readBackendTasks } from "@/lib/backend-client";

/** Values that turn the relay on; anything else leaves it off. */
const RELAY_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isBackendRelayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return RELAY_ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RELAY ?? "").trim().toLowerCase());
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
  },
): Promise<Array<Record<string, unknown>> | null> {
  const env = options.env ?? process.env;
  if (!isBackendRelayEnabled(env)) return null;
  const read = options.fetchTasks ?? readBackendTasks;
  const result = await read();
  if (!result.ok) return null;
  const tasks = Array.isArray(result.body?.tasks) ? result.body.tasks : [];
  return tasks.filter((task) => {
    if (options.kind !== "all" && (task?.kind ?? "code") !== options.kind) return false;
    return options.includeArchived || task?.status !== "archived";
  });
}

/**
 * Pre-flight checks before a live session is created, and the settings that depend
 * on the task kind. Pure: the caller turns the returned reason into its own error.
 */

/**
 * Which refusal applies, in this precedence: a task that no longer exists, then an
 * archived one, then a lease held by another worker. The order matters — an
 * archived task must be reported as archived even when a stale lease exists.
 *
 * Returns null when the session may be created.
 */
export function preflightLiveSession({ hasTask, status, leaseHeldElsewhere }) {
  if (hasTask !== true) return "task-not-found";
  if (status === "archived") return "archived";
  if (leaseHeldElsewhere === true) return "lease-busy";
  return null;
}

/**
 * The permission mode a new session runs with: a Bot follows its own record (and
 * falls back to the task), while a Code task uses the value just normalized into
 * the task and otherwise what the task already had.
 */
export function resolveSessionPermissionMode({ isBot, botPermissionMode, updatedPermissionMode, taskPermissionMode }) {
  if (isBot === true) return botPermissionMode ?? taskPermissionMode;
  return updatedPermissionMode ?? taskPermissionMode;
}

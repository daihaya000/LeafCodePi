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

/** A Bot task is a Bot session only when it also carries the Bot it belongs to. */
export function isBotTask(task) {
  return task?.kind === "bot" && Boolean(task.botId);
}

/**
 * Where the session runs: the registered project's root, or the task's own
 * directory for tasks without a project.
 */
export function liveSessionWorkspace({ projectRootPath, taskDirectory }) {
  return projectRootPath ?? taskDirectory;
}

/**
 * Session titles keep Bot sessions namespaced so a Bot's session list cannot be
 * confused with a Code task of the same title.
 */
export function liveSessionName({ isBot, title }) {
  return isBot === true ? `bot:${title}` : title;
}

/**
 * Skill permission for a new session: a freshly normalized value wins, otherwise
 * the task keeps whatever it already had.
 */
export function resolveSessionSkillPermission({ updatedSkillPermission, taskSkillPermission }) {
  return updatedSkillPermission ?? taskSkillPermission;
}

/**
 * Pre-flight checks before a live session is created, and the settings that depend
 * on the task kind. Pure: the caller turns the returned reason into its own error.
 */

/**
 * Which thinking level a new session starts with: the level stored on the task when
 * it is a valid one, otherwise the model's own default, and nothing at all when
 * there is no model to ask.
 */
export function resolveSessionThinkingLevelSource({ hasStoredLevel, hasModel }) {
  if (hasStoredLevel === true) return "stored";
  return hasModel === true ? "model-default" : "none";
}

/** Shared wording for the two task-level refusals every entry point reports. */
export const TASK_NOT_FOUND_MESSAGE = "タスクが見つかりません";
export const TASK_ARCHIVED_MESSAGE = "アーカイブされたタスクです";

/**
 * The HTTP status and message a caller raises for a refusal from
 * `preflightLiveSession`. The lease wording is injected because it is shared with the
 * worker-facing API; the two task-level messages are owned here.
 */
export function liveSessionRefusalError(refusal, { leaseBusyMessage }) {
  if (refusal === "task-not-found") return { status: 404, message: TASK_NOT_FOUND_MESSAGE };
  if (refusal === "archived") return { status: 409, message: TASK_ARCHIVED_MESSAGE };
  return { status: 409, message: leaseBusyMessage };
}

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
 * How a task's stored model resolved. `hasStoredModel` separates "no model chosen
 * yet" (nothing to resolve, never an error) from "a stored model failed to load":
 * an Auto route may replace it for this session only, and without one the session
 * cannot start.
 */
export function resolveStoredModelOutcome({ hasStoredModel, resolved, autoFallback }) {
  if (hasStoredModel !== true || resolved === true) return "resolved";
  return autoFallback === true ? "auto-fallback" : "unavailable";
}

/**
 * Refusal for an explicitly chosen account: a missing record is 404, a paused one
 * 409. Only an explicit account id can refuse here; an implicitly inherited one
 * just falls back to no account.
 */
export function resolveSessionAccountRefusal({ explicit, hasTaskAccountId, hasAccountRecord, accountEnabled }) {
  if (explicit !== true || hasTaskAccountId !== true) return null;
  if (hasAccountRecord !== true) return "account-not-found";
  if (accountEnabled !== true) return "account-paused";
  return null;
}

/**
 * Which account the new session runs under: the route's account wins; otherwise the
 * task's account is reused only when it exists, is enabled, and either the task has
 * no provider or that provider routes through accounts and the account holds it.
 * Anything else means no account (the ambient auth path).
 */
export function resolveSessionAccountId({
  modelRouteAccountId, taskAccountId, hasAccountRecord, accountEnabled,
  hasProviderId, routedThroughAccounts, accountHasProvider,
}) {
  if (modelRouteAccountId != null) return modelRouteAccountId;
  if (hasAccountRecord !== true || accountEnabled !== true) return null;
  if (hasProviderId !== true) return taskAccountId ?? null;
  if (routedThroughAccounts === true && accountHasProvider === true) return taskAccountId ?? null;
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

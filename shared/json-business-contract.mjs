import { DEFINITION_ROUTES, definitionTarget, definitionBodyLimit, publicDefinitionBody } from "./definition-contract.mjs";
import { PROVIDER_ROUTES, providerTarget, publicProviderBody } from "./provider-contract.mjs";
import { PROVIDER_AUTH_ROUTES, providerAuthTarget, publicProviderAuthBody } from "./provider-auth-contract.mjs";
import { ACCOUNT_ROUTES, accountTarget, publicAccountBody } from "./account-contract.mjs";
import { USAGE_ROUTES, usageTarget, publicUsageBody } from "./usage-contract.mjs";
import { PEER_ROUTES, peerTarget, peerFacing, peerCommand, publicPeerBody } from "./peer-contract.mjs";
import { WORKSPACE_ROUTES, WORKSPACE_BODY_LIMIT, workspaceTarget, publicWorkspaceBody } from "./workspace-contract.mjs";
import { PROJECT_ROUTES, PROJECT_BODY_LIMIT, projectTarget, publicProjectBody } from "./project-contract.mjs";
import { TASK_COLLECTION_ROUTES, TASK_COLLECTION_BODY_LIMIT, taskCollectionTarget, publicTaskCollectionBody } from "./task-collection-contract.mjs";
import { TASK_LIFECYCLE_ROUTES, TASK_LIFECYCLE_BODY_LIMIT, taskLifecycleTarget, publicTaskLifecycleBody } from "./task-lifecycle-contract.mjs";
import { TASK_HISTORY_ROUTES, TASK_HISTORY_BODY_LIMIT, taskHistoryTarget, publicTaskHistoryBody } from "./task-history-contract.mjs";
import { BOT_OVERVIEW_ROUTES, BOT_OVERVIEW_BODY_LIMIT, botOverviewTarget, publicBotOverviewBody } from "./bot-overview-contract.mjs";
import { BOT_ROUTINE_ROUTES, botRoutineTarget, botRoutineBodyLimit, publicBotRoutineBody } from "./bot-routine-contract.mjs";
import { BOT_CODE_ROUTES, botCodeTarget, botCodeBodyLimit, publicBotCodeBody } from "./bot-code-contract.mjs";
import { BOT_CONVERSATION_ROUTES, botConversationTarget, botConversationBodyLimit, publicBotConversationBody } from "./bot-conversation-contract.mjs";
import { BOT_LIFECYCLE_ROUTES, botLifecycleTarget, botLifecycleBodyLimit, publicBotLifecycleBody } from "./bot-lifecycle-contract.mjs";
import { TASK_SUPERVISION_ROUTES, TASK_SUPERVISION_BODY_LIMIT, taskSupervisionTarget, publicTaskSupervisionBody } from "./task-supervision-contract.mjs";
import { TASK_ASSISTANCE_ROUTES, taskAssistanceTarget, taskAssistanceBodyLimit, publicTaskAssistanceBody } from "./task-assistance-contract.mjs";
import { TASK_COMPACTION_ROUTES, taskCompactionTarget, taskCompactionBodyLimit, taskCompactionTimeout, publicTaskCompactionBody } from "./task-compaction-contract.mjs";
import { TASK_SESSION_ROUTES, TASK_SESSION_BODY_LIMIT, taskSessionTarget, publicTaskSessionBody } from "./task-session-contract.mjs";
import { TASK_GOAL_LOOP_ROUTES, taskGoalLoopTarget, taskGoalLoopBodyLimit, publicTaskGoalLoopBody } from "./task-goal-loop-contract.mjs";
import { TASK_CONVERSATION_ROUTES, taskConversationTarget, taskConversationBodyLimit, publicTaskConversationBody } from "./task-conversation-contract.mjs";
import { TASK_EXECUTION_SETTINGS_ROUTES, TASK_EXECUTION_SETTINGS_BODY_LIMIT, taskExecutionSettingsTarget, publicTaskExecutionSettingsBody } from "./task-execution-settings-contract.mjs";
/** Pure wire contract. Owner validation/commands never run in the Web relay. */
export const JSON_BUSINESS_PATH = "/internal/json-business";
export const JSON_BUSINESS_HEADERS = Object.freeze({ origin: "x-leafcode-business-origin", host: "x-leafcode-business-host", authorized: "x-leafcode-business-authorized", operation: "x-leafcode-business-operation" });
export const JSON_BUSINESS_ROUTES = Object.freeze({
  "git/branches": ["GET"], "git/commit": ["POST"], "git/commit-message": ["POST"],
  "git/init": ["POST"], "git/log": ["GET"], "git/merge": ["POST"],
  "git/pr": ["GET", "POST"], "git/pull": ["POST"], "git/push": ["POST"],
  "git/repositories": ["GET"], "git/rm": ["POST"], "git/show": ["GET"], "diff/files": ["GET"],
  ...DEFINITION_ROUTES, ...PROVIDER_ROUTES, ...PROVIDER_AUTH_ROUTES, ...ACCOUNT_ROUTES, ...USAGE_ROUTES, ...PEER_ROUTES, ...WORKSPACE_ROUTES, ...PROJECT_ROUTES, ...TASK_COLLECTION_ROUTES, ...TASK_LIFECYCLE_ROUTES, ...TASK_HISTORY_ROUTES, ...TASK_EXECUTION_SETTINGS_ROUTES, ...TASK_CONVERSATION_ROUTES, ...TASK_GOAL_LOOP_ROUTES, ...TASK_SESSION_ROUTES, ...TASK_COMPACTION_ROUTES, ...TASK_ASSISTANCE_ROUTES, ...TASK_SUPERVISION_ROUTES, ...BOT_LIFECYCLE_ROUTES, ...BOT_CONVERSATION_ROUTES, ...BOT_CODE_ROUTES, ...BOT_ROUTINE_ROUTES, ...BOT_OVERVIEW_ROUTES,
});
export const JSON_BUSINESS_BODY_LIMIT = 1024 * 1024;
export function jsonBusinessTarget(path) {
  if (Object.hasOwn(JSON_BUSINESS_ROUTES, path) && !path.includes("[")) return { route: path, params: {} };
  return botOverviewTarget(path) ?? botRoutineTarget(path) ?? botCodeTarget(path) ?? botConversationTarget(path) ?? botLifecycleTarget(path) ?? definitionTarget(path) ?? providerTarget(path) ?? providerAuthTarget(path) ?? accountTarget(path) ?? usageTarget(path) ?? peerTarget(path) ?? workspaceTarget(path) ?? projectTarget(path) ?? taskCollectionTarget(path) ?? taskLifecycleTarget(path) ?? taskHistoryTarget(path) ?? taskExecutionSettingsTarget(path) ?? taskConversationTarget(path) ?? taskGoalLoopTarget(path) ?? taskSessionTarget(path) ?? taskCompactionTarget(path) ?? taskAssistanceTarget(path) ?? taskSupervisionTarget(path);
}
export function jsonBusinessBodyLimit(path, method) { if (botOverviewTarget(path)) return BOT_OVERVIEW_BODY_LIMIT; if (botRoutineTarget(path)) return botRoutineBodyLimit(path, method); if (botCodeTarget(path)) return botCodeBodyLimit(path); if (botConversationTarget(path)) return botConversationBodyLimit(path); if (botLifecycleTarget(path)) return botLifecycleBodyLimit(path, method); if (taskSupervisionTarget(path)) return TASK_SUPERVISION_BODY_LIMIT; if (taskAssistanceTarget(path)) return taskAssistanceBodyLimit(path); if (taskCompactionTarget(path)) return taskCompactionBodyLimit(path); if (taskSessionTarget(path)) return TASK_SESSION_BODY_LIMIT; if (taskGoalLoopTarget(path)) return taskGoalLoopBodyLimit(path, method); if (taskConversationTarget(path)) return taskConversationBodyLimit(path); if (taskExecutionSettingsTarget(path)) return TASK_EXECUTION_SETTINGS_BODY_LIMIT; if (taskHistoryTarget(path)) return TASK_HISTORY_BODY_LIMIT; if (taskLifecycleTarget(path)) return TASK_LIFECYCLE_BODY_LIMIT; if (taskCollectionTarget(path)) return TASK_COLLECTION_BODY_LIMIT; if (projectTarget(path)) return PROJECT_BODY_LIMIT; if (workspaceTarget(path)) return WORKSPACE_BODY_LIMIT; if (peerFacing(path)) return 4096; const target = definitionTarget(path); return target ? definitionBodyLimit(target.route) : JSON_BUSINESS_BODY_LIMIT; }
export function jsonBusinessCommand(path, method) { return method !== "GET" && Boolean(definitionTarget(path) || providerTarget(path) || providerAuthTarget(path) || accountTarget(path) || usageTarget(path) || peerCommand(path, method) || projectTarget(path) || taskCollectionTarget(path) || taskLifecycleTarget(path) || taskHistoryTarget(path) || taskExecutionSettingsTarget(path) || taskConversationTarget(path) || taskGoalLoopTarget(path) || taskSessionTarget(path) || taskCompactionTarget(path) || taskAssistanceTarget(path) || taskSupervisionTarget(path) || botLifecycleTarget(path) || botConversationTarget(path) || botCodeTarget(path) || botRoutineTarget(path) || botOverviewTarget(path)); }
export const JSON_BUSINESS_RESPONSE_LIMIT = 32 * 1024 * 1024;
export function jsonBusinessTimeout(route) { if (taskCompactionTarget(route)) return taskCompactionTimeout(route); return route === "git/pr" ? 200_000 : 180_000; }
export function jsonBusinessMutates(route, method) { return method !== "GET" && route !== "git/commit-message" && !peerFacing(route) && !workspaceTarget(route); }
const fields = {
  "git/branches": ["current", "branches", "defaultTarget", "upstream", "ahead", "remotes", "hasRemote"],
  "git/commit": ["ok", "summary", "stdout"], "git/commit-message": ["message", "source", "model", "warning"],
  "git/init": ["ok", "directory"], "git/log": ["commits", "refs", "currentBranch", "hasMore"],
  "git/merge": ["ok", "merged", "into", "summary", "restored", "strandedOn", "mergeSucceeded", "conflict", "worktreeConflict"],
  "git/pr": ["available", "version", "hint", "ok", "url"], "git/pull": ["ok", "summary"], "git/push": ["ok", "summary"],
  "git/repositories": ["repositories"], "git/rm": ["ok", "path"], "git/show": ["commit", "files", "diff"],
  "diff/files": ["git", "branch", "files", "additions", "deletions", "count"],
};
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
/** Schema checks at the public boundary; never forward arbitrary owner headers or top-level fields. */
export function publicJsonBusinessResult(route, value, method) {
  const target = jsonBusinessTarget(route);
  if (!target) return null;
  route = target.route;
  if (!record(value) || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) return null;
  const headers = {};
  for (const name of ["cache-control", "etag", "x-content-type-options", ...(peerFacing(route) ? ["retry-after"] : [])]) {
    const field = value.headers?.[name];
    if (field !== undefined && (typeof field !== "string" || /[\r\n]/.test(field))) return null;
    if (field !== undefined) headers[name] = field;
  }
  if (value.status === 304) return value.body === null ? { status: 304, headers, body: null } : null;
  if (Object.hasOwn(TASK_EXECUTION_SETTINGS_ROUTES, route)) {
    const body = publicTaskExecutionSettingsBody(route,value.body,value.status);
    return body ? {status:value.status,headers,body} : null;
  }
  if (Object.hasOwn(BOT_OVERVIEW_ROUTES, route)) {
    const body = publicBotOverviewBody(route, value.body, value.status, method);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(BOT_ROUTINE_ROUTES, route)) {
    const body = publicBotRoutineBody(route, value.body, value.status, method);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(BOT_CODE_ROUTES, route)) {
    const body = publicBotCodeBody(route, value.body, value.status, method);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(BOT_CONVERSATION_ROUTES, route)) {
    const body = publicBotConversationBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(BOT_LIFECYCLE_ROUTES, route)) {
    const body = publicBotLifecycleBody(route, value.body, value.status, method);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_SUPERVISION_ROUTES, route)) {
    const body = publicTaskSupervisionBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_ASSISTANCE_ROUTES, route)) {
    const body = publicTaskAssistanceBody(route, value.body, value.status, method);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_COMPACTION_ROUTES, route)) {
    const body = publicTaskCompactionBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_SESSION_ROUTES, route)) {
    const body = publicTaskSessionBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_GOAL_LOOP_ROUTES, route)) {
    const body = publicTaskGoalLoopBody(route, value.body, value.status, method);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_CONVERSATION_ROUTES, route)) {
    const body = publicTaskConversationBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_HISTORY_ROUTES, route)) {
    const body = publicTaskHistoryBody(route,value.body,value.status);
    return body ? {status:value.status,headers,body} : null;
  }
  if (Object.hasOwn(TASK_LIFECYCLE_ROUTES, route)) {
    const body = publicTaskLifecycleBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(TASK_COLLECTION_ROUTES, route)) {
    const body = publicTaskCollectionBody(value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(PROJECT_ROUTES, route)) {
    const body = publicProjectBody(value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(WORKSPACE_ROUTES, route)) {
    const body = publicWorkspaceBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(PEER_ROUTES, route)) {
    const body = publicPeerBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(USAGE_ROUTES, route)) {
    const body = publicUsageBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(ACCOUNT_ROUTES, route)) {
    const body = publicAccountBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(PROVIDER_AUTH_ROUTES, route)) {
    const body = publicProviderAuthBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(PROVIDER_ROUTES, route)) {
    const body = publicProviderBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(DEFINITION_ROUTES, route)) {
    const body = publicDefinitionBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (!record(value.body)) return null;
  const input = value.body;
  if (input.error !== undefined && typeof input.error !== "string") return null;
  if (!input.error && value.status < 400) {
    switch (route) {
      case "git/branches": if (typeof input.current !== "string" || !Array.isArray(input.branches) || !Array.isArray(input.remotes) || typeof input.ahead !== "number") return null; break;
      case "git/log": if (!Array.isArray(input.commits) || !Array.isArray(input.refs) || typeof input.hasMore !== "boolean") return null; break;
      case "git/show": if (typeof input.commit !== "string" || (!Array.isArray(input.files) && typeof input.diff !== "string")) return null; break;
      case "git/repositories": if (!Array.isArray(input.repositories)) return null; break;
      case "diff/files": if (typeof input.git !== "boolean" || !Array.isArray(input.files) || typeof input.additions !== "number" || typeof input.deletions !== "number") return null; break;
      case "git/commit-message": if (typeof input.message !== "string" || !["direct", "fallback"].includes(input.source)) return null; break;
      case "git/pr": if (typeof input.available !== "boolean" && (input.ok !== true || typeof input.url !== "string")) return null; break;
      default: if (input.ok !== true) return null;
    }
  }
  const body = {};
  for (const name of ["error", ...fields[route]]) if (Object.hasOwn(input, name)) body[name] = input[name];
  if (route === "git/commit-message" && body.model !== undefined && body.model !== null) {
    if (!record(body.model) || typeof body.model.providerID !== "string" || typeof body.model.modelID !== "string") return null;
    const model = { providerID: body.model.providerID, modelID: body.model.modelID };
    if (body.model.accountId !== undefined) { if (typeof body.model.accountId !== "string") return null; model.accountId = body.model.accountId; }
    body.model = model;
  }
  return { status: value.status, headers, body };
}

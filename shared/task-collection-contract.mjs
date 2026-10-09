/** Pure task collection DTOs. Never publish SDK instances, pending request bodies or credentials. */
export const TASK_COLLECTION_ROUTES = Object.freeze({ tasks: ["GET", "POST", "DELETE"] });
// Existing image aggregate is 12 MiB (16 MiB base64), plus 64 KiB file text and 32k prompt characters.
export const TASK_COLLECTION_BODY_LIMIT = 18 * 1024 * 1024;
export function taskCollectionTarget(path) { return path === "tasks" ? { route: path, params: {} } : null; }
const record = v => v && typeof v === "object" && !Array.isArray(v);
export function publicTaskOperation(v) { return record(v) && typeof v.id === "string" && /^[0-9a-f-]{36}$/.test(v.id) && ["not-started", "unknown", "complete"].includes(v.execution) ? { id: v.id, execution: v.execution } : null; }
function fields(input, schema) {
  if (!record(input)) return null;
  const result = {};
  for (const [key, accepts] of Object.entries(schema)) if (input[key] !== undefined) { if (!accepts(input[key])) return null; result[key] = input[key]; }
  return result;
}
const string = v => typeof v === "string", nullable = v => v === null || string(v), boolean = v => typeof v === "boolean", number = v => typeof v === "number" && Number.isFinite(v);
function model(v) { const result = fields(v, { providerID: string, modelID: string, accountId: string, variant: string }); return result && string(result.providerID) && string(result.modelID) ? result : null; }
export function publicTaskSummary(v) {
  if (!record(v) || !string(v.id) || !["working", "ready", "idle", "error", "archived", "unknown"].includes(v.status)) return null;
  const out = fields(v, {
    ...Object.fromEntries(["id", "projectName", "title", "label", "directory", "isolation", "status", "providerID", "modelID", "thinkingLevel", "accountId", "skillPermission", "permissionMode", "createdAt", "updatedAt"].map(k => [k, string])),
    ...Object.fromEntries(["projectId", "botId", "supervisorBotId", "sessionId", "sessionFile", "revertLeafId", "manualAbortedAssistantId", "agent", "error"].map(k => [k, nullable])),
    kind: v => ["code", "bot"].includes(v), titleAutoUpdate: boolean, accountIdExplicit: boolean, limitError: boolean, hangRetryCount: number,
  });
  if (!out) return null;
  if (v.responseModel !== undefined) { out.responseModel = model(v.responseModel); if (!out.responseModel) return null; }
  if (v.todoProgress !== undefined) { out.todoProgress = fields(v.todoProgress, { completed: number, total: number }); if (!out.todoProgress || !number(out.todoProgress.completed) || !number(out.todoProgress.total)) return null; }
  if (v.goalLoopSummary !== undefined) { out.goalLoopSummary = fields(v.goalLoopSummary, { status: string, maxTurns: number, turnCount: number }); if (!out.goalLoopSummary || !string(out.goalLoopSummary.status) || !number(out.goalLoopSummary.maxTurns) || !number(out.goalLoopSummary.turnCount)) return null; }
  return out;
}
function attention(v) {
  const out = fields(v, { taskId: string, title: string, originTaskId: string });
  if (!out || !string(out.taskId) || !string(out.title) || !Array.isArray(v.kinds) || v.kinds.some(k => !["permission", "question"].includes(k))) return null;
  return { ...out, kinds: [...v.kinds] };
}
export function publicAutoDecision(v) {
  const out = model(v); if (!out) return null;
  const rest = fields(v, { tier: string, mode: string, reason: string, candidateIndex: number, usedPreset: boolean }); if (!rest) return null;
  if (v.escalation !== undefined) { rest.escalation = model(v.escalation); if (!rest.escalation) return null; }
  return { ...out, ...rest };
}
export function publicTaskCollectionBody(input, status) {
  if (!record(input)) return null;
  const out = fields(input, { error: string, ok: boolean, removed: number }); if (!out) return null;
  if (status < 400) {
    for (const key of ["tasks", "attention"]) if (input[key] !== undefined) { if (!Array.isArray(input[key])) return null; out[key] = input[key].map(key === "tasks" ? publicTaskSummary : attention); if (out[key].some(v => v === null)) return null; }
    if (input.task !== undefined) { out.task = publicTaskSummary(input.task); if (!out.task) return null; }
    if (input.autoDecision !== undefined) { out.autoDecision = publicAutoDecision(input.autoDecision); if (!out.autoDecision) return null; }
    if (!out.task && !out.tasks && !out.attention && out.ok !== true) return null;
  }
  if (input.operation !== undefined) { out.operation = publicTaskOperation(input.operation); if (!out.operation) return null; }
  return out;
}

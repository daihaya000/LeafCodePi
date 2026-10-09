import { publicTaskOperation } from "./task-collection-contract.mjs";

export const BOT_ROUTINE_ROUTES = Object.freeze({
  "bots/[id]/routines": ["GET", "POST"],
  "bots/[id]/routines/[routineId]": ["GET", "PATCH", "DELETE"],
  "bots/[id]/routines/[routineId]/run": ["POST"],
});

export function botRoutineTarget(path) {
  if (Object.hasOwn(BOT_ROUTINE_ROUTES, path)) return { route: path, params: {} };
  const match = /^bots\/([^/]+)\/routines(?:\/([^/]+)(\/run)?)?$/.exec(path);
  if (!match) return null;
  try {
    return {
      route: "bots/[id]/routines" + (match[2] ? "/[routineId]" : "") + (match[3] ?? ""),
      params: { id: decodeURIComponent(match[1]), ...(match[2] ? { routineId: decodeURIComponent(match[2]) } : {}) },
    };
  } catch { return null; }
}

export function botRoutineBodyLimit(path, method) {
  return method === "DELETE" || botRoutineTarget(path)?.route.endsWith("/run") ? 4096 : 64 * 1024;
}

/** Authored routine configuration and bounded run bookkeeping, never arbitrary storage/SDK fields. */
export function publicRoutine(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of ["id", "botId", "name", "prompt", "schedule", "createdAt", "updatedAt"]) {
    if (typeof value[key] !== "string") return null;
    out[key] = value[key];
  }
  if (typeof value.enabled !== "boolean" || !Number.isInteger(value.failureCount) || value.failureCount < 0 ||
      !(value.lastRunAt === null || typeof value.lastRunAt === "string")) return null;
  return { ...out, enabled: value.enabled, failureCount: value.failureCount, lastRunAt: value.lastRunAt };
}

export function publicBotRoutineBody(route, value, status, method) {
  if (!Object.hasOwn(BOT_ROUTINE_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) {
    if (typeof value.error !== "string") return null;
    out.error = value.error;
  }
  if (value.routine !== undefined) {
    out.routine = publicRoutine(value.routine);
    if (!out.routine) return null;
  }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (method === "DELETE") {
      if (value.ok !== true) return null;
      out.ok = true;
    } else if (route === "bots/[id]/routines" && method === "GET") {
      if (!Array.isArray(value.routines)) return null;
      out.routines = value.routines.map(publicRoutine);
      if (out.routines.some(routine => !routine)) return null;
    } else if (!out.routine) return null;
  }
  if (value.operation !== undefined) {
    out.operation = publicTaskOperation(value.operation);
    if (!out.operation) return null;
  }
  return out;
}

/** Internal transport only; never expose the backend token to browser code. */
export const BACKEND_PROTOCOL_VERSION = 1;
export const BACKEND_PROTOCOL_HEADER = "x-leafcode-backend-protocol";
export const BACKEND_HEALTH_PATH = "/internal/health";
/** Read-only: the pending snapshot per task, so a reconnecting WebUI can re-display state. */
export const BACKEND_PENDING_SNAPSHOTS_PATH = "/internal/pending-snapshots";
/** Read-only: the Backend's own view of the task store, before the Web relay is enabled. */
export const BACKEND_TASKS_PATH = "/internal/tasks";
export const DEFAULT_BACKEND_PORT = 18776;

/** Authentication precedes version checks, including health requests. */
export const BACKEND_ERROR_CODES = Object.freeze({
  unauthorized: "BACKEND_UNAUTHORIZED",
  incompatible: "BACKEND_PROTOCOL_MISMATCH",
  notFound: "BACKEND_NOT_FOUND",
  methodNotAllowed: "BACKEND_METHOD_NOT_ALLOWED",
  internal: "BACKEND_INTERNAL_ERROR",
  /** The Backend has no Pi runtime attached, so this read cannot be served yet. */
  runtimeUnavailable: "BACKEND_RUNTIME_UNAVAILABLE",
});

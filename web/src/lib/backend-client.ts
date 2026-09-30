/**
 * Server-side client for the independent Backend process.
 *
 * This module is only imported by route handlers and other server code: the token lives in the
 * server environment and must never reach browser code. Every call is explicit about what went
 * wrong (not configured / unreachable / unauthorized / incompatible / timeout) so a route can
 * decide between falling back to the in-process path and reporting an error.
 */
import {
  BACKEND_BOTS_PATH,
  BACKEND_HEALTH_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
  BACKEND_TASKS_PATH,
  DEFAULT_BACKEND_PORT,
} from "@shared/backend-protocol.mjs";

export const BACKEND_REQUEST_TIMEOUT_MS = 10_000;

export type BackendFailureReason =
  | "not-configured"
  | "unreachable"
  | "unauthorized"
  | "incompatible"
  | "timeout"
  | "bad-response";

export type BackendResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; reason: BackendFailureReason; status?: number };

/** The environment the client reads; `process.env` satisfies it, and tests pass a literal. */
export type BackendEnv = Record<string, string | undefined>;

/** Where the Backend is and whether this process may talk to it. */
export function backendClientStatus(env: BackendEnv = process.env): {
  configured: boolean;
  url: string;
} {
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  return { configured: Boolean(token), url: backendBaseUrl(env) };
}

export function backendBaseUrl(env: BackendEnv = process.env): string {
  const configured = env.LEAFCODE_PI_BACKEND_URL?.trim();
  const base = configured || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
  return base.replace(/\/+$/, "");
}

/**
 * One authenticated read against the Backend. The request carries the protocol header, and the
 * response status decides the failure reason: 401/403 unauthorized, 409 incompatible, anything else
 * non-2xx is a bad response. Network errors and timeouts are separated so a caller can retry the
 * latter and treat the former as "Backend is down".
 */
export async function fetchBackendJson<T>(
  path: string,
  options: {
    env?: BackendEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<BackendResult<T>> {
  const env = options.env ?? process.env;
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) return { ok: false, reason: "not-configured" };
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BACKEND_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await doFetch(`${backendBaseUrl(env)}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized", status: response.status };
  if (response.status === 409) return { ok: false, reason: "incompatible", status: response.status };
  if (!response.ok) return { ok: false, reason: "bad-response", status: response.status };
  try {
    return { ok: true, status: response.status, body: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "bad-response", status: response.status };
  }
}

/** The health fields this client relies on; the Backend may report more. */
export type BackendHealth = {
  ready: boolean;
  status: string;
  pid: number;
  protocolVersion?: number;
  instanceId?: string;
  startedAt?: string;
  /** The build id of the runtime the Backend attached; null while nothing is attached. */
  runtimeGeneration?: string | null;
};

/** Whether the Backend process is up and has attached its runtime. */
export function readBackendHealth(options: Parameters<typeof fetchBackendJson>[1] = {}) {
  return fetchBackendJson<BackendHealth>(BACKEND_HEALTH_PATH, options);
}

/**
 * The runtime generation the Host pinned when it started this Backend, if it recorded one.
 * Empty means "not pinned": this WebUI has no expectation to compare against.
 */
export function expectedBackendGeneration(env: BackendEnv = process.env): string {
  return env.LEAFCODE_PI_BACKEND_GENERATION?.trim() ?? "";
}

/**
 * Whether the running Backend is the generation this WebUI expects. An unpinned expectation is
 * compatible, and a Backend that reports no generation is only compatible with no expectation:
 * talking to a build we cannot identify risks writing to the wrong runtime.
 */
export function isBackendGenerationCompatible(expected: string, running: string | null | undefined): boolean {
  if (!expected) return true;
  return typeof running === "string" && running.length > 0 && running === expected;
}

/** The Backend's own view of the Bot store. */
export function readBackendBots(options: Parameters<typeof fetchBackendJson>[1] = {}) {
  return fetchBackendJson<{ bots: Array<Record<string, unknown>> }>(BACKEND_BOTS_PATH, options);
}

/** The Backend's own view of the task store (stored rows, not the Web's derived summaries). */
export function readBackendTasks(options: Parameters<typeof fetchBackendJson>[1] = {}) {
  return fetchBackendJson<{ tasks: Array<Record<string, unknown>> }>(BACKEND_TASKS_PATH, options);
}

import { runtimeGenerationStatus } from "../../shared/backend-generation.mjs";
import {
  BACKEND_HEALTH_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
} from "../../shared/backend-protocol.mjs";

/**
 * The Host's own view of the Backend it started.
 *
 * The Host must not trust the listening socket: a Backend that has not finished its startup sequence,
 * or one built from a different runtime bundle, must not be treated as the owner of the Pi runtime.
 * Readiness therefore means `ready === true` *and* the generation the Host pinned.
 *
 * The token stays in the Host process; nothing here is exposed to the WebUI.
 */
export const BACKEND_HEALTH_TIMEOUT_MS = 5_000;

export function backendHealthUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}${BACKEND_HEALTH_PATH}`;
}

/** One authenticated health read. Never throws: a failure is a reason, not an exception. */
export async function readBackendHealth({
  baseUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = BACKEND_HEALTH_TIMEOUT_MS,
  expectedGeneration = "",
} = {}) {
  if (!token) return { ok: false, reason: "not-configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(backendHealthUrl(baseUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
      },
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
  if (!response.ok && response.status !== 503) return { ok: false, reason: "bad-response", status: response.status };
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "bad-response", status: response.status };
  }
  // Detached/starting is reachable, not ready. Do not accept a generic HTTP 503 as health.
  if (response.status === 503 && (body?.service !== "leafcode-pi-backend" ||
    body?.protocolVersion !== BACKEND_PROTOCOL_VERSION || body?.ready !== false || body?.status !== "starting")) {
    return { ok: false, reason: "bad-response", status: response.status };
  }
  const generation = runtimeGenerationStatus(expectedGeneration, body?.runtimeGeneration ?? null);
  return {
    ok: true,
    status: response.status,
    ready: body?.ready === true && generation.matches,
    generation,
  };
}

/** Failure reasons that a retry cannot fix: the Host must change something first. */
const TERMINAL_REASONS = new Set(["not-configured", "unauthorized", "incompatible"]);

/**
 * Polls until the Backend is genuinely ready, or the deadline passes.
 * A terminal failure (bad token, protocol mismatch) stops immediately instead of burning the timeout.
 */
export async function waitForBackendReady({
  read,
  timeoutMs = 60_000,
  pollMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (typeof read !== "function") throw new Error("read is required");
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let last = { ok: false, reason: "unreachable" };
  for (;;) {
    attempts += 1;
    last = await read();
    if (last?.ok === true && last.ready === true) return { ok: true, attempts, health: last };
    if (last?.ok === false && TERMINAL_REASONS.has(last.reason)) {
      return { ok: false, attempts, reason: last.reason, health: last };
    }
    if (now() >= deadline) return { ok: false, attempts, reason: "timeout", health: last };
    await sleep(pollMs);
  }
}

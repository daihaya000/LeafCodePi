/**
 * Decide whether a live Backend may be restarted from the control plane / tray.
 * Only a positively known live Goal Loop blocks recovery. Timeout / unreachable
 * mean the owner cannot protect sessions anyway — allow the restart so the Host
 * (and the operator) can unstick a hung Backend without waiting for hang-watch.
 */
import { readBackendHealth } from "./backend-health.js";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION, BACKEND_RUNTIME_CONTROL_PATH, DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";

const HEALTH_TIMEOUT_MS = 1_500;

export const RESTART_BUSY_MESSAGE = "別の再起動が進行中です。完了してから再試行してください。";

export const BACKEND_UNAVAILABLE_MESSAGE =
  "Backendの実行状態を確認できないため再起動を拒否しました。状態を確認してから再試行してください。";

/** A living runtime owner must answer authoritatively before it can be restarted. */
export async function backendRuntimeRestartBlockReason({ baseUrl, token, expectedGeneration, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS }) {
  // A missing URL must not read as "cannot verify": the Backend's default port is the fallback.
  const base = (baseUrl?.trim() || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).replace(/\/+$/, "");
  // Keep a separate deadline alive through JSON consumption, not only response headers.
  const healthFetch = (url, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.unshift(init.signal);
    return fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
  };
  const health = await readBackendHealth({ baseUrl: base, token, expectedGeneration, fetchImpl: healthFetch, timeoutMs });
  // Hung / starting / wrong-generation owners cannot protect live sessions — allow recovery.
  if (!health.ok) {
    if (health.reason === "timeout" || health.reason === "unreachable") return null;
    return BACKEND_UNAVAILABLE_MESSAGE;
  }
  if (!health.ready) return null;
  try {
    const response = await fetchImpl(`${base}${BACKEND_RUNTIME_CONTROL_PATH}`, {
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
    });
    if (!response.ok || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)) {
      return BACKEND_UNAVAILABLE_MESSAGE;
    }
    const body = await response.json();
    if (!Array.isArray(body.taskIds) || body.taskIds.some((id) => typeof id !== "string")) {
      return BACKEND_UNAVAILABLE_MESSAGE;
    }
    return body.taskIds.length > 0
      ? `Goal Loop が ${body.taskIds.length} 件実行中のため Backend の再起動を拒否しました。ループを停止・完了してから再試行してください。`
      : null;
  } catch {
    // Control probe failed after a healthy owner answered — fail closed (sessions may be live).
    return BACKEND_UNAVAILABLE_MESSAGE;
  }
}

export function serviceRestartBusyReason(restarting) {
  return restarting ? RESTART_BUSY_MESSAGE : null;
}

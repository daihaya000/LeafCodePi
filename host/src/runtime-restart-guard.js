import { readBackendHealth } from "./backend-health.js";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION, BACKEND_RUNTIME_CONTROL_PATH, DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";

const HEALTH_TIMEOUT_MS = 1_500;

/** A living runtime owner must answer authoritatively before it can be restarted. */
export async function backendRuntimeRestartBlockReason({ baseUrl, token, expectedGeneration, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS }) {
  const unavailable = "Backendの実行状態を確認できないため再起動を拒否しました。状態を確認してから再試行してください。";
  // A missing URL must not read as "cannot verify": the Backend's default port is the fallback.
  const base = (baseUrl?.trim() || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).replace(/\/+$/, "");
  // Keep a separate deadline alive through JSON consumption, not only response headers.
  const healthFetch = (url, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.unshift(init.signal);
    return fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
  };
  const health = await readBackendHealth({ baseUrl: base, token, expectedGeneration, fetchImpl: healthFetch, timeoutMs });
  if (!health.ok || !health.ready) return unavailable;
  try {
    const response = await fetchImpl(`${base}${BACKEND_RUNTIME_CONTROL_PATH}`, {
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
    });
    if (!response.ok || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)) return unavailable;
    const body = await response.json();
    if (!Array.isArray(body.taskIds) || body.taskIds.some((id) => typeof id !== "string")) return unavailable;
    return body.taskIds.length > 0
      ? `Goal Loop が ${body.taskIds.length} 件実行中のため Backend の再起動を拒否しました。ループを停止・完了してから再試行してください。`
      : null;
  } catch { return unavailable; }
}

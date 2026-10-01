import { readBackendHealth } from "./backend-health.js";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION, BACKEND_RUNTIME_CONTROL_PATH } from "../../shared/backend-protocol.mjs";

/** A living runtime owner must answer authoritatively before it can be restarted. */
export async function backendRuntimeRestartBlockReason({ baseUrl, token, expectedGeneration, fetchImpl = fetch }) {
  const unavailable = "Backendの実行状態を確認できないため再起動を拒否しました。状態を確認してから再試行してください。";
  const health = await readBackendHealth({ baseUrl, token, expectedGeneration, fetchImpl, timeoutMs: 1500 });
  if (!health.ok || !health.ready) return unavailable;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${BACKEND_RUNTIME_CONTROL_PATH}`, {
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
      signal: AbortSignal.timeout(1500), cache: "no-store",
    });
    if (!response.ok || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)) return unavailable;
    const body = await response.json();
    if (!Array.isArray(body.taskIds) || body.taskIds.some((id) => typeof id !== "string")) return unavailable;
    return body.taskIds.length > 0
      ? `Goal Loop が ${body.taskIds.length} 件実行中のため Backend の再起動を拒否しました。ループを停止・完了してから再試行してください。`
      : null;
  } catch { return unavailable; }
}

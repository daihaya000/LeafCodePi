import { backendBaseUrl, expectedBackendGeneration, isBackendGenerationCompatible, readBackendHealth } from "./backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "./webui-auth";
import { CONFIGURATION_PATH, CONFIGURATION_HEADERS } from "@shared/configuration-contract.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";
/** SSR consumes the owner's snapshot. Failure leaves client hydration pending, never reads local state. */
export async function readServerSettingsSnapshot(request: Request): Promise<Record<string, string | null> | undefined> {
  const authorized = isWebUiRequestAuthorized(request), token = process.env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token || webUiAuthRequired() && !authorized) return undefined;
  const expected = expectedBackendGeneration();
  if (expected) { const health = await readBackendHealth({ timeoutMs: 1500 }); if (!health.ok || !isBackendGenerationCompatible(expected, health.body.runtimeGeneration)) return undefined; }
  const url = new URL(request.url), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1500);
  const abort = () => controller.abort(); request.signal.addEventListener("abort", abort, { once: true }); if (request.signal.aborted) controller.abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${backendBaseUrl()}${CONFIGURATION_PATH}/settings`, { method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), [CONFIGURATION_HEADERS.origin]: url.origin,
        [CONFIGURATION_HEADERS.host]: request.headers.get("host") ?? url.host, [CONFIGURATION_HEADERS.authorized]: authorized ? "1" : "0" } });
    if (!response.ok || !response.body) return undefined;
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4 * 1024 * 1024) return undefined; chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const values = JSON.parse(new TextDecoder().decode(bytes)).values;
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 1024) return undefined;
    // React Server Components require a plain-object snapshot; dangerous keys were rejected below.
    const snapshot: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) { if (["__proto__", "constructor", "prototype"].includes(key) || value !== null && typeof value !== "string") return undefined; snapshot[key] = value; }
    return snapshot;
  } catch { return undefined; }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); controller.abort(); await reader?.cancel().catch(() => {}); }
}

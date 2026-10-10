import { hostname } from "node:os";
import { displayLeafcodePiDataPath } from "./display-data-path.mjs";

/** Only display text already exposed by the legacy root/login layouts. No file reads. */
export function readWebUiPresentation(dataDir = process.env.LEAFCODE_PI_DATA_DIR) {
  return { hostname: hostname(), authFileDisplayPath: displayLeafcodePiDataPath("webui-auth.json", process.platform, dataDir) };
}

/** Public, non-business bootstrap resource shared by Next and the independent gateway. */
export function webUiPresentationResponse(method) {
  const headers = { "cache-control": "no-store", "content-type": "application/json", "x-content-type-options": "nosniff" };
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, allow: "GET, HEAD, OPTIONS" } });
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD, OPTIONS" } });
  try {
    const body = JSON.stringify(readWebUiPresentation());
    return new Response(method === "HEAD" ? null : body, { headers });
  } catch {
    return new Response(method === "HEAD" ? null : '{"error":"WebUI display information unavailable"}', { status: 503, headers });
  }
}

import { NextResponse } from "next/server";
import { backendClientStatus, readBackendHealth } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnostic view of the independent Backend process: whether this WebUI is allowed to talk to it
 * and, when it is, the Backend's own readiness. The bearer token never leaves the server — only the
 * derived summary is returned, and only to an authorized WebUI caller.
 */
export async function GET(req: Request) {
  if (webUiAuthRequired() && !isWebUiRequestAuthorized(req)) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const status = backendClientStatus();
  if (!status.configured) {
    return NextResponse.json({ configured: false, url: status.url, backend: null });
  }
  const health = await readBackendHealth();
  return NextResponse.json({
    configured: true,
    url: status.url,
    backend: health.ok
      ? { reachable: true, ready: health.body.ready === true, status: health.body.status }
      : { reachable: false, ready: false, status: null, reason: health.reason },
  });
}

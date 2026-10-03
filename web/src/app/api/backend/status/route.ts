import { NextResponse } from "next/server";
import {
  backendClientStatus,
  expectedBackendGeneration,
  isBackendGenerationCompatible,
  readBackendHealth,
} from "@/lib/backend-client";
import { webOwnsRuntime } from "@/lib/backend-relay";
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
  // The generation check is a diagnostic here; the relay refuses to use a mismatched Backend.
  const expected = expectedBackendGeneration();
  return NextResponse.json({
    configured: true,
    url: status.url,
    // This WebUI is always the Backend's client: it never owns the runtime, so there is no hand-over
    // left to report. The ownership is still exposed for diagnostics.
    ownsRuntime: webOwnsRuntime(),
    backend: health.ok
      ? {
          reachable: true,
          ready: health.body.ready === true,
          status: health.body.status,
          // Process start time verifies restarts even when the rebuilt bundle hash is unchanged.
          startedAt: health.body.startedAt ?? null,
          generation: {
            expected: expected || null,
            running: health.body.runtimeGeneration ?? null,
            matches: isBackendGenerationCompatible(expected, health.body.runtimeGeneration),
          },
        }
      : { reachable: false, ready: false, status: null, reason: health.reason },
  });
}

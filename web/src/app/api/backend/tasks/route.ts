import { NextResponse } from "next/server";
import { backendClientStatus, readBackendTasks } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only relay of the Backend's own task view.
 *
 * This is deliberately *not* the WebUI's `/api/tasks`: that route returns the Web's derived
 * summaries (todo progress, attention, live streaming state) which the Backend does not produce yet.
 * Until the switch, this endpoint exists so the relay path can be exercised end to end, and it
 * reports why it cannot answer instead of silently falling back to the in-process store.
 */
export async function GET(req: Request) {
  if (webUiAuthRequired() && !isWebUiRequestAuthorized(req)) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const status = backendClientStatus();
  if (!status.configured) {
    return NextResponse.json(
      { error: "Backendが設定されていません", reason: "not-configured" },
      { status: 503 },
    );
  }
  const result = await readBackendTasks();
  if (!result.ok) {
    return NextResponse.json(
      { error: "Backendから取得できませんでした", reason: result.reason },
      { status: 503 },
    );
  }
  return NextResponse.json({ source: "backend", tasks: result.body.tasks ?? [] });
}

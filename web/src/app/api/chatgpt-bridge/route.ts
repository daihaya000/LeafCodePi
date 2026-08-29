import { NextRequest, NextResponse } from "next/server";
import { resolveHostControlUrl } from "@/lib/host-control";
import { isSafeChatGptProjectId } from "@/lib/chatgpt-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (projectId !== null && !isSafeChatGptProjectId(projectId)) {
    return noStore(NextResponse.json({ ok: false, error: "invalid projectId" }, { status: 400 }));
  }
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  try {
    const response = await fetch(`${resolveHostControlUrl()}/chatgpt-bridge/status${query}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => ({ ok: false, state: "unavailable" }));
    return noStore(NextResponse.json(body, { status: response.ok ? response.status : response.status || 503 }));
  } catch {
    return noStore(NextResponse.json({ ok: false, state: "unavailable", error: "ホストに接続できません" }, { status: 503 }));
  }
}

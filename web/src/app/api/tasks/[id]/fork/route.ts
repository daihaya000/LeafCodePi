import { NextRequest, NextResponse } from "next/server";
import { forkTask } from "@/lib/pi/task-fork";
import { jsonError } from "@/lib/pi/harness";
import { forwardTaskAdmin } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as { entryId?: unknown } | null;
    const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) return NextResponse.json({ error: "entryId が必要です" }, { status: 400 });
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskAdmin(id, { action: "fork", entryId });
      if (!forwarded.ok) return NextResponse.json({ error: "Backendで分岐できません", code: "BACKEND_FORWARD_FAILED" }, { status: 502 });
      return NextResponse.json(forwarded.body, { status: forwarded.status });
    }
    return NextResponse.json(await forkTask(id, entryId));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

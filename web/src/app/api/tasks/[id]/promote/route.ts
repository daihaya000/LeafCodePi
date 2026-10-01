import { NextRequest, NextResponse } from "next/server";
import { jsonError, promoteTask } from "@/lib/pi/harness";
import { forwardTaskAdmin } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      destinationPath?: unknown;
    } | null;
    if (typeof body?.destinationPath !== "string" || !body.destinationPath.trim()) {
      return NextResponse.json(
        { error: "destinationPath が必要です" },
        { status: 400 },
      );
    }
    // The session is rewired where it lives: the owning Backend answers and its answer is replayed.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskAdmin(id, { action: "promote", destinationPath: body.destinationPath });
      if (!forwarded.ok) {
        return NextResponse.json(
          { error: "Backendで実行できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
          { status: 502 },
        );
      }
      return NextResponse.json(forwarded.body, { status: forwarded.status });
    }
    return NextResponse.json(await promoteTask(id, body.destinationPath));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  archiveTask,
  destroyTask,
  jsonError,
  restoreTask,
} from "@/lib/pi/harness";
import { getTaskDetailBounded } from "@/lib/pi/get-task-detail-bounded";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskDetail } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // After the cutover the Backend owns the session, so its detail is the real one. There is no local
    // fallback: reading a session this process does not own would report stale state as current.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskDetail(id);
      if (forwarded.ok) return NextResponse.json({ task: forwarded.detail });
      if (forwarded.reason === "not-configured") {
        return NextResponse.json(
          { error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "Backendから取得できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
    }
    // CodeRequestCard polls this while Code runs; bound ensureLive hangs.
    return NextResponse.json({ task: await getTaskDetailBounded(id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { archived?: boolean } | null;
    if (body?.archived === false) {
      return NextResponse.json({ task: restoreTask(id) });
    }
    return NextResponse.json({ error: "unsupported patch" }, { status: 400 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const hard = req.nextUrl.searchParams.get("hard") === "1";
    if (hard) {
      return NextResponse.json(await destroyTask(id));
    }
    return NextResponse.json({ task: await archiveTask(id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

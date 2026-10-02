import { NextRequest, NextResponse } from "next/server";
import {
  archiveTask,
  destroyTask,
  jsonError,
  restoreTask,
} from "@/lib/pi/harness";
import { getTaskDetailBounded } from "@/lib/pi/get-task-detail-bounded";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskDetail, forwardTaskTeardown } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const messages = req.nextUrl.searchParams.get("messages");
    const detailMessages =
      messages === "page" || messages === "omit" ? { messages } as const : undefined;
    // After the cutover the Backend owns the session, so its detail is the real one. There is no local
    // fallback: reading a session this process does not own would report stale state as current.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskDetail(id, detailMessages);
      if (forwarded.ok) return NextResponse.json({ task: forwarded.detail });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
      }
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
    // The running session lives in the owner: only it can stop and dispose it before the row changes.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskTeardown(id, hard ? "destroy" : "archive");
      if (!forwarded.ok) {
        if (forwarded.reason === "not-found") {
          return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
        }
        return NextResponse.json(
          { error: "Backendで実行できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
          { status: 502 },
        );
      }
      // Same shapes as the in-process path: the archived summary, or `{ ok: true }` for a delete.
      return NextResponse.json(hard ? forwarded.result ?? { ok: true } : { task: forwarded.result });
    }
    if (hard) {
      return NextResponse.json(await destroyTask(id));
    }
    return NextResponse.json({ task: await archiveTask(id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  archiveTask,
  destroyTask,
  getTaskDetail,
  jsonError,
  restoreTask,
} from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return NextResponse.json({ task: await getTaskDetail(id) });
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

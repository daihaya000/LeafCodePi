import { NextRequest, NextResponse } from "next/server";
import { revertTask, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { entryId?: unknown } | null;
    const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) {
      return NextResponse.json({ error: "entryId が指定されていません" }, { status: 400 });
    }
    const result = await revertTask(id, entryId);
    return NextResponse.json(result);
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

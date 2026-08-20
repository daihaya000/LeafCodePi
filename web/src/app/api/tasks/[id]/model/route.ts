import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskModel } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { model?: string } | null;
    if (!body?.model) {
      return NextResponse.json({ error: "model が必要です" }, { status: 400 });
    }
    return NextResponse.json({ task: await setTaskModel(id, body.model) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

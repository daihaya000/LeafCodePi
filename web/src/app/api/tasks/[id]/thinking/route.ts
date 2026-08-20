import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskThinkingLevel } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { thinkingLevel?: string } | null;
    if (!body?.thinkingLevel) {
      return NextResponse.json({ error: "thinkingLevel が必要です" }, { status: 400 });
    }
    return NextResponse.json({ task: await setTaskThinkingLevel(id, body.thinkingLevel) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

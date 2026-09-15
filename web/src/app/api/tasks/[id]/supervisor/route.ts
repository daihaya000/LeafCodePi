import { NextRequest, NextResponse } from "next/server";
import { handoffTaskToBot, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { botId?: unknown } | null;
    if (typeof body?.botId !== "string" || !body.botId.trim()) {
      return NextResponse.json({ error: "botId が必要です" }, { status: 400 });
    }
    return NextResponse.json({ task: await handoffTaskToBot(body.botId, id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

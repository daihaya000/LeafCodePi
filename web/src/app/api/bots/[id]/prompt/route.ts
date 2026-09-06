import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { jsonError, promptTask } from "@/lib/pi/harness";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const id = (await params).id; if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { prompt?: unknown } | null;
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    return NextResponse.json({ task: await promptTask(botTaskId(id), body.prompt) });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}

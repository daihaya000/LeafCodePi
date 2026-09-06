import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { abortTask, jsonError } from "@/lib/pi/harness";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const id = (await params).id; if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 }); return NextResponse.json({ task: await abortTask(botTaskId(id)) }); }
  catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}

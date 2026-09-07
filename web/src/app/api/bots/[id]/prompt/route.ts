import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { isPromptImageList } from "@/lib/prompt-images";
import { jsonError, promptTask } from "@/lib/pi/harness";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const id = (await params).id; if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { prompt?: unknown; images?: unknown } | null;
    if (typeof body?.prompt !== "string") return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (body.images !== undefined && !isPromptImageList(body.images)) return NextResponse.json({ error: "invalid images" }, { status: 400 });
    if (!body.prompt.trim() && !body.images?.length) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    const task = body.images === undefined
      ? await promptTask(botTaskId(id), body.prompt)
      : await promptTask(botTaskId(id), body.prompt, body.images);
    return NextResponse.json({ task });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}

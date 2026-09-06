import { NextRequest, NextResponse } from "next/server";
import { deleteBot, getBot, patchBot, botTaskId } from "@/lib/bots";
import { resetTaskSession, setTaskModel, setTaskThinkingLevel } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function idOf(params: Promise<{ id: string }>) { return (await params).id; }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bot = getBot(await idOf(params));
  return bot ? NextResponse.json({ bot }) : NextResponse.json({ error: "Bot not found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const hasModel = body?.model !== undefined;
  const hasThinkingLevel = body?.thinkingLevel !== undefined;
  if (
    !body ||
    (body.name !== undefined && typeof body.name !== "string") ||
    (body.soul !== undefined && typeof body.soul !== "string") ||
    (hasModel && (typeof body.model !== "string" || !body.model.trim())) ||
    (hasThinkingLevel && !isThinkingLevel(body.thinkingLevel))
  ) {
    return NextResponse.json({ error: "invalid bot patch" }, { status: 400 });
  }
  if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });

  try {
    const patch: Parameters<typeof patchBot>[1] = {};
    if (body.name !== undefined) patch.name = body.name as string;
    if (body.soul !== undefined) patch.soul = body.soul as string;
    if (hasModel) {
      // Use the same route validation and live-session update as Code TaskView.
      // setTaskModel updates the running bot session (or defers safely while busy).
      const task = await setTaskModel(botTaskId(id), (body.model as string).trim());
      patch.model = (body.model as string).trim();
      if (!hasThinkingLevel && task.thinkingLevel) patch.thinkingLevel = task.thinkingLevel;
    }
    if (hasThinkingLevel) {
      const task = await setTaskThinkingLevel(botTaskId(id), body.thinkingLevel as string);
      patch.thinkingLevel = task.thinkingLevel;
    }
    const bot = patchBot(id, patch);
    if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    if (body.soul !== undefined) resetTaskSession(botTaskId(id));
    return NextResponse.json({ bot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid bot patch";
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  const deleted = deleteBot(id);
  return deleted ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Bot not found" }, { status: 404 });
}

import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { isPromptImageList, isPromptImageWithinSize } from "@/lib/prompt-images";
import { goalLoopCommand, jsonError, promptTask } from "@/lib/pi/harness";
import { clampGoalLoopCooldownSeconds, clampGoalLoopMaxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS } from "@/lib/goal-loop-settings";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const id = (await params).id; if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { prompt?: unknown; images?: unknown; goalLoop?: unknown } | null;
    if (typeof body?.prompt !== "string") return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) return NextResponse.json({ error: "invalid images" }, { status: 400 });
    if (!body.prompt.trim() && !body.images?.length) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (body.goalLoop !== undefined) {
      if (body.goalLoop === null || typeof body.goalLoop !== "object" || Array.isArray(body.goalLoop)) return NextResponse.json({ error: "invalid goalLoop" }, { status: 400 });
      const loop = body.goalLoop as { acceptance?: unknown; maxTurns?: unknown; cooldownSeconds?: unknown; forceFullRun?: unknown };
      const validAcceptance = loop.acceptance === undefined || (Array.isArray(loop.acceptance) && loop.acceptance.every((item) => typeof item === "string"));
      const validNumber = (value: unknown) => value === undefined || typeof value === "number" || typeof value === "string";
      if (!validAcceptance || !validNumber(loop.maxTurns) || !validNumber(loop.cooldownSeconds) || (loop.forceFullRun !== undefined && typeof loop.forceFullRun !== "boolean")) return NextResponse.json({ error: "invalid goalLoop" }, { status: 400 });
      const acceptance = loop.acceptance === undefined ? [] : loop.acceptance as string[];
      const result = await goalLoopCommand(botTaskId(id), {
        action: "start",
        goal: body.prompt,
        acceptance,
        maxTurns: clampGoalLoopMaxTurns(loop.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
        cooldownSeconds: clampGoalLoopCooldownSeconds(loop.cooldownSeconds),
        forceFullRun: loop.forceFullRun === true,
      });
      return NextResponse.json({ task: null, loop: result });
    }
    const task = body.images === undefined
      ? await promptTask(botTaskId(id), body.prompt)
      : await promptTask(botTaskId(id), body.prompt, body.images);
    return NextResponse.json({ task });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}

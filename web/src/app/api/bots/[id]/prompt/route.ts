import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { isPromptFileList, isPromptFileText, isPromptFileWithinSize, isPromptImageList, isPromptImageWithinSize, isPromptTextWithinSize, MAX_PROMPT_ATTACHMENTS, type PromptFileInput } from "@/lib/prompt-images";
import { goalLoopCommand, isTaskRuntimeBusyForGoalLoopStart, jsonError, promptTask } from "@/lib/pi/harness";
import { isGoalLoopLiveStatus } from "@/lib/pi/goal-loop-state";
import { clampGoalLoopCooldownSeconds, clampGoalLoopMaxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS, normalizeGoalLoopAcceptance } from "@/lib/goal-loop-settings";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const id = (await params).id; if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { prompt?: unknown; images?: unknown; files?: unknown; goalLoop?: unknown } | null;
    if (typeof body?.prompt !== "string") return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (!isPromptTextWithinSize(body.prompt)) return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
    if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) return NextResponse.json({ error: "invalid images" }, { status: 400 });
    if (body.files !== undefined && (!isPromptFileList(body.files) || body.files.some((file) => !isPromptFileWithinSize(file) || !isPromptFileText(file)))) return NextResponse.json({ error: "invalid files: UTF-8 text only" }, { status: 400 });
    if ((body.images?.length ?? 0) + (body.files?.length ?? 0) > MAX_PROMPT_ATTACHMENTS) return NextResponse.json({ error: `添付は${MAX_PROMPT_ATTACHMENTS}件までです` }, { status: 400 });
    if (!body.prompt.trim() && !body.images?.length && !body.files?.length) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (body.goalLoop !== undefined) {
      if (body.files?.length) return NextResponse.json({ error: "Goal loop の開始では画像のみ添付できます" }, { status: 400 });
      if (body.goalLoop === null || typeof body.goalLoop !== "object" || Array.isArray(body.goalLoop)) return NextResponse.json({ error: "invalid goalLoop" }, { status: 400 });
      const loop = body.goalLoop as { acceptance?: unknown; maxTurns?: unknown; cooldownSeconds?: unknown; forceFullRun?: unknown };
      // Shared with tasks/[id]/goal-loop, bots/[id]/code-session, and bot-code-relay.ts's
      // code_session tool: acceptance repeats in every Goal Loop turn's prompt for the run's
      // life, so every entry point that can start one must apply the same bound.
      const acceptance = normalizeGoalLoopAcceptance(loop.acceptance);
      const validNumber = (value: unknown) => value === undefined || typeof value === "number" || typeof value === "string";
      if (acceptance === null || !validNumber(loop.maxTurns) || !validNumber(loop.cooldownSeconds) || (loop.forceFullRun !== undefined && typeof loop.forceFullRun !== "boolean")) return NextResponse.json({ error: "invalid goalLoop" }, { status: 400 });
      if (isTaskRuntimeBusyForGoalLoopStart(botTaskId(id))) {
        return NextResponse.json({ error: "タスクが実行中のため Goal Loop を開始できません" }, { status: 409 });
      }
      const result = await goalLoopCommand(botTaskId(id), {
        action: "start",
        goal: body.prompt,
        acceptance,
        maxTurns: clampGoalLoopMaxTurns(loop.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
        cooldownSeconds: clampGoalLoopCooldownSeconds(loop.cooldownSeconds),
        forceFullRun: loop.forceFullRun === true,
        images: body.images,
      });
      if (!result || !isGoalLoopLiveStatus(result.status)) {
        return NextResponse.json({ error: "Goal Loop を開始できませんでした" }, { status: 409 });
      }
      return NextResponse.json({ task: null, loop: result });
    }
    const task = body.files === undefined
      ? body.images === undefined
        ? await promptTask(botTaskId(id), body.prompt)
        : await promptTask(botTaskId(id), body.prompt, body.images)
      : await promptTask(botTaskId(id), body.prompt, body.images, { files: body.files as PromptFileInput[] });
    return NextResponse.json({ task });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}

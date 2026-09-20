import { NextRequest, NextResponse } from "next/server";
import { getBot, patchBot } from "@/lib/bots";
import { isPromptTextWithinSize } from "@/lib/prompt-images";
import { getProject, getTask, patchTask } from "@/lib/store";
import { continueBotCodeTask, createBotCodeTask, getTaskSummariesWithTodoProgress, goalLoopCommand, jsonError, stopBotCodeTask, abortTaskIncludingColdGoalLoop } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { reconcileOrphanedWorkingTasks } from "@/lib/task-runtime-lease";
import { isRoomDelegatedCodeTask } from "@/lib/pi/bot-code-relay";
import { isGoalLoopLiveStatus, readGoalLoopState } from "@/lib/pi/goal-loop-state";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
  normalizeGoalLoopAcceptance,
} from "@/lib/goal-loop-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function botId(params: Promise<{ id: string }>): Promise<string> {
  return (await params).id;
}

type GoalLoopInput = {
  acceptance: string[];
  maxTurns: number;
  cooldownSeconds: number;
  forceFullRun: boolean;
};

function parseGoalLoop(value: unknown): GoalLoopInput | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const loop = value as {
    acceptance?: unknown;
    maxTurns?: unknown;
    cooldownSeconds?: unknown;
    forceFullRun?: unknown;
  };
  if (
    (loop.maxTurns !== undefined && typeof loop.maxTurns !== "number" && typeof loop.maxTurns !== "string") ||
    (loop.cooldownSeconds !== undefined && typeof loop.cooldownSeconds !== "number" && typeof loop.cooldownSeconds !== "string") ||
    (loop.forceFullRun !== undefined && typeof loop.forceFullRun !== "boolean")
  ) {
    return null;
  }
  const acceptance = normalizeGoalLoopAcceptance(loop.acceptance);
  if (acceptance === null) return null;
  return {
    acceptance,
    maxTurns: clampGoalLoopMaxTurns(loop.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
    cooldownSeconds: clampGoalLoopCooldownSeconds(loop.cooldownSeconds),
    forceFullRun: loop.forceFullRun === true,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  reconcileOrphanedWorkingTasks();
  const bot = getBot(id);
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  // Active Code sessions only — archived rows are not polled by the panel.
  const tasks = (await getTaskSummariesWithTodoProgress(false)).filter(
    (task) =>
      (task.botId === id || task.supervisorBotId === id) &&
      task.kind !== "bot" &&
      !isRoomDelegatedCodeTask(task.id),
  );
  // Bundle full Goal Loop DTOs so the client does not N+1 /goal-loop.
  const loops: Record<string, ReturnType<typeof readGoalLoopState>> = {};
  for (const task of tasks) {
    if (!task.goalLoopSummary || !task.sessionId) continue;
    loops[task.id] = readGoalLoopState(task.directory, task.sessionId);
  }
  return NextResponse.json({ tasks, loops });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  try {
    reconcileOrphanedWorkingTasks();
      const bot = getBot(id);
      if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
      // The Bot's tool policy owns Code delegation: "すべて拒否" must refuse the panel start too, the
      // same way the code_session tool refuses it, instead of creating a denied Code task.
      if (bot.permissionMode === "deny") {
        return NextResponse.json({ error: "ツール権限が「すべて拒否」のボットはCodeを起動できません" }, { status: 403 });
      }
      if (bot.enabled === false) {
        return NextResponse.json({ error: "無効なボットではCodeセッションを起動できません" }, { status: 403 });
      }
      const body = (await req.json().catch(() => null)) as {
        projectId?: unknown;
        prompt?: unknown;
        model?: unknown;
        thinkingLevel?: unknown;
        permissionMode?: unknown;
        goalLoop?: unknown;
      } | null;
      if (
        body?.projectId !== null &&
        (typeof body?.projectId !== "string" || !body.projectId.trim())
      ) {
        return NextResponse.json({ error: "projectId is required" }, { status: 400 });
      }
      const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : null;
      const project = projectId ? getProject(projectId) : null;
      if (projectId && !project) {
        return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
      }
      if (project?.archived) {
        return NextResponse.json({ error: "アーカイブ済みのプロジェクトではCodeセッションを起動できません" }, { status: 409 });
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return NextResponse.json({ error: "prompt is required" }, { status: 400 });
      }
      if (!isPromptTextWithinSize(body.prompt)) {
        return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
      }
      if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) {
        return NextResponse.json({ error: "invalid model" }, { status: 400 });
      }
      if (body.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return NextResponse.json({ error: "invalid thinkingLevel" }, { status: 400 });
      }
      if (
        body.permissionMode !== undefined &&
        body.permissionMode !== "allow" &&
        body.permissionMode !== "ask" &&
        body.permissionMode !== "deny"
      ) {
        return NextResponse.json({ error: "invalid permissionMode" }, { status: 400 });
      }
      const goalLoop = parseGoalLoop(body?.goalLoop);
      if (goalLoop === null) {
        return NextResponse.json({ error: "invalid goalLoop" }, { status: 400 });
      }

      // Registered through the Bot outbox so this run reports back into the conversation.
      const task = await createBotCodeTask(id, {
        projectId,
        prompt: body.prompt,
        ...(typeof body.model === "string" ? { model: body.model.trim() } : {}),
        ...(isThinkingLevel(body.thinkingLevel) ? { thinkingLevel: body.thinkingLevel } : {}),
        permissionMode:
          body.permissionMode === "allow" || body.permissionMode === "deny" || body.permissionMode === "ask"
            ? body.permissionMode
            : bot.permissionMode ?? "ask",
        ...(goalLoop ? { goalLoop } : {}),
      });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

function isBotPanelCodeTask(
  task: NonNullable<ReturnType<typeof getTask>>,
  botId: string,
): boolean {
  return (
    task.kind !== "bot" &&
    (task.botId === botId || task.supervisorBotId === botId) &&
    task.status !== "archived" &&
    !isRoomDelegatedCodeTask(task.id)
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  try {
    reconcileOrphanedWorkingTasks();
      const bot = getBot(id);
      if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
      const body = (await req.json().catch(() => null)) as {
        action?: unknown;
        prompt?: unknown;
        taskId?: unknown;
        goalLoopAction?: unknown;
        maxTurns?: unknown;
      } | null;
      const taskId = typeof body?.taskId === "string" ? body.taskId : bot.codeSessionTaskId;
      if (!taskId) return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      if (body?.action === "clear" || body?.action === "unlink") {
        // Respect body.taskId (parallel Code sessions); only clear the Bot link when it matches.
        const linked = getTask(taskId);
        if (!linked || linked.status === "archived") {
          if (linked?.supervisorBotId === id) patchTask(taskId, { supervisorBotId: null });
          if (bot.codeSessionTaskId === taskId) patchBot(id, { codeSessionTaskId: null });
          return NextResponse.json({ task: null });
        }
        if (!isBotPanelCodeTask(linked, id)) {
          return NextResponse.json({ error: "Code session not found" }, { status: 404 });
        }
        const loop = readGoalLoopState(linked.directory, linked.sessionId);
        // Goal Loop idles between turns; still stop so unlink does not leave the loop running.
        if (linked.status === "working" || isGoalLoopLiveStatus(loop?.status)) {
          try {
            await stopBotCodeTask(id, taskId);
          } catch (error) {
            try {
              await abortTaskIncludingColdGoalLoop(taskId);
            } catch (abortError) {
              console.warn(
                `[code-session] failed to stop linked task ${taskId} on ${body.action}:`,
                abortError instanceof Error ? abortError.message : String(abortError),
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          const after = getTask(taskId);
          const afterLoop = after
            ? readGoalLoopState(after.directory, after.sessionId)
            : null;
          if (
            after &&
            (after.status === "working" || isGoalLoopLiveStatus(afterLoop?.status))
          ) {
            return NextResponse.json(
              { error: "Code セッションを停止できませんでした" },
              { status: 409 },
            );
          }
        }
        if (linked.supervisorBotId === id) patchTask(taskId, { supervisorBotId: null });
        if (bot.codeSessionTaskId === taskId) {
          patchBot(id, { codeSessionTaskId: null });
        }
        return NextResponse.json({ task: null });
      }
      const task = getTask(taskId);
      // Room workers (kind=bot) and Room-delegated Code tasks are owned by the Room API.
      if (!task || !isBotPanelCodeTask(task, id)) {
        if (bot.codeSessionTaskId === taskId) patchBot(id, { codeSessionTaskId: null });
        return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      }
      if (body?.action === "goal-loop") {
        if (
          body.goalLoopAction !== "pause" &&
          body.goalLoopAction !== "resume" &&
          body.goalLoopAction !== "stop" &&
          body.goalLoopAction !== "complete"
        ) {
          return NextResponse.json({ error: "invalid goalLoopAction" }, { status: 400 });
        }
        // Resume starts new Goal work; pause/stop/complete must still work after disable.
        if (body.goalLoopAction === "resume" && bot.enabled === false) {
          return NextResponse.json({ error: "無効なボットではGoal Loopを再開できません" }, { status: 403 });
        }
        const loop = await goalLoopCommand(taskId, {
          action: body.goalLoopAction,
          maxTurns:
            body.goalLoopAction === "resume" && body.maxTurns !== undefined
              ? clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS)
              : undefined,
        });
        if (
          body.goalLoopAction === "resume" &&
          (!loop || !isGoalLoopLiveStatus(loop.status))
        ) {
          return NextResponse.json(
            { error: "Goal Loop を再開できませんでした" },
            { status: 409 },
          );
        }
        return NextResponse.json({ loop });
      }
      if (body?.action === "abort") {
        return NextResponse.json({ task: await stopBotCodeTask(id, taskId) });
      }
      if (body?.action === "prompt") {
        if (typeof body.prompt !== "string" || !body.prompt.trim()) {
          return NextResponse.json({ error: "prompt is required" }, { status: 400 });
        }
        if (!isPromptTextWithinSize(body.prompt)) {
          return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
        }
        // Continuing a Code session is delegation too: a Bot that denies everything must not drive it.
        if (bot.permissionMode === "deny") {
          return NextResponse.json({ error: "ツール権限が「すべて拒否」のボットはCodeを起動できません" }, { status: 403 });
        }
        if (bot.enabled === false) {
          return NextResponse.json({ error: "無効なボットではCodeセッションを続行できません" }, { status: 403 });
        }
        return NextResponse.json({ task: await continueBotCodeTask(id, taskId, body.prompt.trim()) });
      }
    return NextResponse.json({ error: "action must be prompt, abort, or goal-loop" }, { status: 400 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
import { NextRequest, NextResponse } from "next/server";
import { getBot, patchBot } from "@/lib/bots";
import { getProject, getTask } from "@/lib/store";
import { continueBotCodeTask, createBotCodeTask, getTaskSummariesWithTodoProgress, goalLoopCommand, jsonError, stopBotCodeTask } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { reconcileOrphanedWorkingTasks } from "@/lib/task-runtime-lease";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
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
    (loop.acceptance !== undefined && (!Array.isArray(loop.acceptance) || loop.acceptance.some((item) => typeof item !== "string"))) ||
    (loop.maxTurns !== undefined && typeof loop.maxTurns !== "number" && typeof loop.maxTurns !== "string") ||
    (loop.cooldownSeconds !== undefined && typeof loop.cooldownSeconds !== "number" && typeof loop.cooldownSeconds !== "string") ||
    (loop.forceFullRun !== undefined && typeof loop.forceFullRun !== "boolean")
  ) {
    return null;
  }
  const acceptance = (loop.acceptance ?? []).map((item) => item.trim()).filter(Boolean);
  if (acceptance.length > 10 || acceptance.some((item) => item.length > 2_000)) return null;
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
  const tasks = (await getTaskSummariesWithTodoProgress(true)).filter(
    (task) => task.botId === id && task.kind !== "bot",
  );
  return NextResponse.json({ tasks });
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
        patchBot(id, { codeSessionTaskId: null });
        return NextResponse.json({ task: null });
      }
      const task = getTask(taskId);
      // Room workers are also stored as kind="bot" with the same botId. This endpoint is the
      // Bot screen's 1:1 Code control surface and must never mutate a Room-owned task.
      if (!task || task.kind === "bot" || task.botId !== id || task.status === "archived") {
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
        const loop = await goalLoopCommand(taskId, {
          action: body.goalLoopAction,
          maxTurns:
            body.goalLoopAction === "resume" && body.maxTurns !== undefined
              ? clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS)
              : undefined,
        });
        return NextResponse.json({ loop });
      }
      if (body?.action === "abort") {
        return NextResponse.json({ task: await stopBotCodeTask(id, taskId) });
      }
      if (body?.action === "prompt") {
        if (typeof body.prompt !== "string" || !body.prompt.trim()) {
          return NextResponse.json({ error: "prompt is required" }, { status: 400 });
        }
        // Continuing a Code session is delegation too: a Bot that denies everything must not drive it.
        if (bot.permissionMode === "deny") {
          return NextResponse.json({ error: "ツール権限が「すべて拒否」のボットはCodeを起動できません" }, { status: 403 });
        }
        return NextResponse.json({ task: await continueBotCodeTask(id, taskId, body.prompt.trim()) });
      }
    return NextResponse.json({ error: "action must be prompt, abort, or goal-loop" }, { status: 400 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
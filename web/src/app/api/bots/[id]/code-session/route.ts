import { NextRequest, NextResponse } from "next/server";
import { getBot, patchBot } from "@/lib/bots";
import { isPromptTextWithinSize } from "@/lib/prompt-images";
import { getProject, getTask, patchTask } from "@/lib/store";
import { continueBotCodeTask, createBotCodeTask, getBotCodeSessionPanelState, goalLoopCommand, jsonError, stopBotCodeTask, abortTaskIncludingColdGoalLoop } from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardBotCodeSessionStart, forwardGoalLoopControl, forwardTaskAbort } from "@/lib/backend-forward";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { reconcileOrphanedWorkingTasks } from "@/lib/task-runtime-lease";
import { isRoomDelegatedCodeTask } from "@/lib/pi/bot-code-relay";
import { isGoalLoopLiveStatus, isGoalLoopSessionOwned, readGoalLoopState } from "@/lib/pi/goal-loop-state";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
  normalizeGoalLoopAcceptance,
} from "@/lib/goal-loop-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A forwarded call that could not be delivered: the status and code the WebUI reports. */
function forwardFailure(reason: string, message: string) {
  if (reason === "not-configured") {
    return NextResponse.json(
      { error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: message, code: "BACKEND_FORWARD_FAILED", reason },
    { status: 502 },
  );
}

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
  const bot = getBot(id);
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  // Bot-scoped enrich: avoid scanning every Code task on each 2s poll.
  return NextResponse.json(await getBotCodeSessionPanelState(id));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  // After the cutover the Bot's Code session is created inside the Backend. The request is validated
  // here (same rules as the owning mode) and then forwarded to the process that will run it.
  const forwardToBackend = localRuntimeBlocked();
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
      const task = forwardToBackend
        ? await (async () => {
            const forwarded = await forwardBotCodeSessionStart(id, {
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
            if (!forwarded.ok) {
              if (forwarded.reason === "not-configured") {
                throw Object.assign(new Error("Backendが実行を所有しています"), { status: 409, code: "RUNTIME_NOT_OWNED" });
              }
              throw Object.assign(new Error("Backendへ転送できません"), { status: 502, code: "BACKEND_FORWARD_FAILED" });
            }
            return forwarded.task;
          })()
        : await createBotCodeTask(id, {
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
  // After the cutover the Bot's session and its outbox belong to the Backend. Stop and Goal Loop control
  // reach it through the existing task endpoints; the rest (continue/clear/unlink) is refused rather
  // than half-run against a session this process does not have.
  if (localRuntimeBlocked()) {
    const bot = getBot(id);
    if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as {
      action?: unknown;
      taskId?: unknown;
      goalLoopAction?: unknown;
      maxTurns?: unknown;
      prompt?: unknown;
    } | null;
    const taskId = typeof body?.taskId === "string" ? body.taskId : bot.codeSessionTaskId;
    if (!taskId) return NextResponse.json({ error: "Code session not found" }, { status: 404 });
    if (body?.action === "abort") {
      const forwarded = await forwardTaskAbort(taskId, { botId: id });
      if (forwarded.ok) return NextResponse.json({ task: forwarded.task });
      if (forwarded.reason === "not-found") return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      return forwardFailure(forwarded.reason, "Backendを停止できません");
    }
    if (body?.action === "clear" || body?.action === "unlink") {
      // The link lives in the store and the Bot record, which the owner writes.
      const forwarded = await forwardBotCodeSessionStart(id, { action: body.action, taskId });
      if (forwarded.ok) return NextResponse.json({ task: forwarded.task });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      }
      return forwardFailure(forwarded.reason, "Backendへ転送できません");
    }
    if (body?.action === "prompt") {
      // Continuing a Bot Code session is delegation too: the owner runs it.
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return NextResponse.json({ error: "prompt is required" }, { status: 400 });
      }
      if (!isPromptTextWithinSize(body.prompt)) {
        return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
      }
      const forwarded = await forwardBotCodeSessionStart(id, {
        action: "continue",
        taskId,
        prompt: body.prompt,
      });
      if (forwarded.ok) return NextResponse.json({ task: forwarded.task });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "Codeセッションが見つかりません" }, { status: 404 });
      }
      return forwardFailure(forwarded.reason, "Backendへ転送できません");
    }
    if (body?.action === "goal-loop") {
      const action = body.goalLoopAction;
      if (action !== "pause" && action !== "resume" && action !== "stop" && action !== "complete") {
        return NextResponse.json({ error: "invalid goalLoopAction" }, { status: 400 });
      }
      const forwarded = await forwardGoalLoopControl(taskId, {
        action,
        ...(action === "resume" && body.maxTurns !== undefined
          ? { maxTurns: clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS) }
          : {}),
        botId: id,
      });
      if (forwarded.ok) return NextResponse.json({ loop: forwarded.loop });
      if (forwarded.reason === "not-found") return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      return forwardFailure(forwarded.reason, "Backendへ転送できません");
    }
    return NextResponse.json(
      { error: "Codeセッションの操作は非所有モードでは未対応です", code: "CODE_SESSION_CONTROL_NOT_SUPPORTED" },
      { status: 409 },
    );
  }
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
        // Session-owned pause/block (including turn_limit) must stop too — same as cold abort.
        if (linked.status === "working" || isGoalLoopSessionOwned(loop)) {
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
          if (after && (after.status === "working" || isGoalLoopSessionOwned(afterLoop))) {
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
        // Goal Loop "停止" must mark the Bot Code outbox stoppedByUser (same as action:abort),
        // otherwise the report turn can start another Code follow-up.
        if (body.goalLoopAction === "stop") {
          const task = await stopBotCodeTask(id, taskId);
          const loop = readGoalLoopState(task.directory, task.sessionId);
          return NextResponse.json({ loop });
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
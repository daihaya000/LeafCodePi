import { NextRequest, NextResponse } from "next/server";
import { getBot, patchBot } from "@/lib/bots";
import { getProject, getTask, listTasks } from "@/lib/store";
import { createTask, abortTask, jsonError, promptTask } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { reconcileOrphanedWorkingTasks } from "@/lib/task-runtime-lease";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function botId(params: Promise<{ id: string }>): Promise<string> {
  return (await params).id;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  reconcileOrphanedWorkingTasks();
  const bot = getBot(id);
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  const tasks = listTasks(true).filter((task) => task.botId === id);
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
      const body = (await req.json().catch(() => null)) as {
        projectId?: unknown;
        prompt?: unknown;
        model?: unknown;
        thinkingLevel?: unknown;
        permissionMode?: unknown;
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

      const task = await createTask({
        projectId,
        prompt: body.prompt,
        botId: id,
        ...(typeof body.model === "string" ? { model: body.model.trim() } : bot.model ? { model: bot.model } : {}),
        ...(isThinkingLevel(body.thinkingLevel)
          ? { thinkingLevel: body.thinkingLevel }
          : bot.thinkingLevel
            ? { thinkingLevel: bot.thinkingLevel }
            : {}),
        permissionMode:
          body.permissionMode === "allow" || body.permissionMode === "deny" || body.permissionMode === "ask"
            ? body.permissionMode
            : bot.permissionMode ?? "ask",
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
      const body = (await req.json().catch(() => null)) as { action?: unknown; prompt?: unknown; taskId?: unknown } | null;
      const taskId = typeof body?.taskId === "string" ? body.taskId : bot.codeSessionTaskId;
      if (!taskId) return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      if (body?.action === "clear" || body?.action === "unlink") {
        patchBot(id, { codeSessionTaskId: null });
        return NextResponse.json({ task: null });
      }
      const task = getTask(taskId);
      if (!task || task.botId !== id || task.status === "archived") {
        return NextResponse.json({ error: "Code session not found" }, { status: 404 });
      }
      if (body?.action === "abort") {
        return NextResponse.json({ task: await abortTask(taskId) });
      }
      if (body?.action === "prompt") {
        if (typeof body.prompt !== "string" || !body.prompt.trim()) {
          return NextResponse.json({ error: "prompt is required" }, { status: 400 });
        }
        return NextResponse.json({ task: await promptTask(taskId, body.prompt) });
      }
    return NextResponse.json({ error: "action must be prompt or abort" }, { status: 400 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
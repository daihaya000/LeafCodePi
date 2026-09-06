import { NextRequest, NextResponse } from "next/server";
import { getBot, patchBot } from "@/lib/bots";
import { getProject, getTask } from "@/lib/store";
import { createTask, abortTask, jsonError, promptTask } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A Bot owns at most one Code task. Serialize launches in this process so two
// button/API requests cannot create two linked sessions at the same time.
const launchLocks = new Map<string, Promise<void>>();

async function withLaunchLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = launchLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  launchLocks.set(id, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (launchLocks.get(id) === current) launchLocks.delete(id);
  }
}

async function botId(params: Promise<{ id: string }>): Promise<string> {
  return (await params).id;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  const bot = getBot(id);
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  const task = bot.codeSessionTaskId ? getTask(bot.codeSessionTaskId) ?? null : null;
  return NextResponse.json({ task });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await botId(params);
  try {
    return await withLaunchLock(id, async () => {
      const bot = getBot(id);
      if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
      const body = (await req.json().catch(() => null)) as {
        projectId?: unknown;
        prompt?: unknown;
        model?: unknown;
        thinkingLevel?: unknown;
        permissionMode?: unknown;
      } | null;
      if (typeof body?.projectId !== "string" || !body.projectId.trim()) {
        return NextResponse.json({ error: "projectId is required" }, { status: 400 });
      }
      const projectId = body.projectId.trim();
      const project = getProject(projectId);
      if (!project) {
        return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
      }
      if (project.archived) {
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

      const linked = bot.codeSessionTaskId ? getTask(bot.codeSessionTaskId) : undefined;
      if (linked && linked.status !== "archived") {
        return NextResponse.json(
          { error: "このBotには既にCodeセッションがあります", task: linked },
          { status: 409 },
        );
      }
      if (bot.codeSessionTaskId) patchBot(id, { codeSessionTaskId: null });

      const task = await createTask({
        projectId,
        prompt: body.prompt,
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
      if (!patchBot(id, { codeSessionTaskId: task.id })) {
        throw Object.assign(new Error("Bot not found"), { status: 404 });
      }
      return NextResponse.json({ task });
    });
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
    const bot = getBot(id);
    if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const taskId = bot.codeSessionTaskId;
    if (!taskId) return NextResponse.json({ error: "Code session not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { action?: unknown; prompt?: unknown } | null;
    if (body?.action === "clear" || body?.action === "unlink") {
      patchBot(id, { codeSessionTaskId: null });
      return NextResponse.json({ task: null });
    }
    const task = getTask(taskId);
    if (!task || task.status === "archived") {
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
import { NextRequest, NextResponse } from "next/server";
import { deleteBot, getBot, normalizeBotSkills, patchBot, botTaskId } from "@/lib/bots";
import { destroyTask, resetTaskSession, setTaskModel, setTaskThinkingLevel } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { isAvatarColor, isAvatarImage } from "@/lib/bot-avatar";
import { isAbsolutePath } from "@/lib/paths";
import { listTasks } from "@/lib/store";
import type { BotSkillsConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function idOf(params: Promise<{ id: string }>) { return (await params).id; }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bot = getBot(await idOf(params));
  return bot ? NextResponse.json({ bot }) : NextResponse.json({ error: "\u30dc\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const hasModel = body?.model !== undefined;
  const hasThinkingLevel = body?.thinkingLevel !== undefined;
  const hasSkills = body?.skills !== undefined;
  const hasExtraRoots = body?.extraRoots !== undefined;
  const hasNotificationsEnabled = body?.notificationsEnabled !== undefined;
  const rawSkills = hasSkills ? body?.skills : undefined;
  const skills = hasSkills ? normalizeBotSkills(rawSkills) : undefined;
  const validSkills = !hasSkills || (rawSkills !== null && typeof rawSkills === "object" && !Array.isArray(rawSkills) &&
    ["inherit", "include", "exclude"].includes((rawSkills as Record<string, unknown>).mode as string) &&
    ["include", "exclude"].every((key) => { const value = (rawSkills as Record<string, unknown>)[key]; return Array.isArray(value) && value.every((item) => typeof item === "string"); }));
  const extraRoots = hasExtraRoots && Array.isArray(body?.extraRoots)
    ? [...new Set((body.extraRoots as unknown[]).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : undefined;
  if (
    !body ||
    (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) ||
    (body.label !== undefined && (typeof body.label !== "string" || !body.label.trim())) ||
    (body.soul !== undefined && typeof body.soul !== "string") ||
    (body.avatarColor !== undefined && !isAvatarColor(body.avatarColor)) ||
    (body.avatarImage !== undefined && body.avatarImage !== null && !isAvatarImage(body.avatarImage)) ||
    (hasNotificationsEnabled && typeof body.notificationsEnabled !== "boolean") ||
    (hasModel && (typeof body.model !== "string" || !body.model.trim())) ||
    (hasThinkingLevel && !isThinkingLevel(body.thinkingLevel)) ||
    !validSkills ||
    (hasExtraRoots && (!Array.isArray(body.extraRoots) || body.extraRoots.some((item) => typeof item !== "string" || !isAbsolutePath(item))))
  ) {
    return NextResponse.json({ error: "\u30dc\u30c3\u30c8\u8a2d\u5b9a\u304c\u4e0d\u6b63\u3067\u3059" }, { status: 400 });
  }
  if (!getBot(id)) return NextResponse.json({ error: "\u30dc\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });

  try {
    const patch: Parameters<typeof patchBot>[1] = {};
    if (body.name !== undefined) patch.name = (body.name as string).trim();
    if (body.label !== undefined) patch.label = (body.label as string).trim();
    if (body.avatarColor !== undefined) patch.avatarColor = body.avatarColor as string;
    if (body.avatarImage !== undefined) patch.avatarImage = body.avatarImage as string | null;
    if (hasNotificationsEnabled) patch.notificationsEnabled = body.notificationsEnabled as boolean;
    if (hasSkills) patch.skills = skills as BotSkillsConfig;
    if (hasExtraRoots) patch.extraRoots = extraRoots ?? [];
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
    if (!bot) return NextResponse.json({ error: "\u30dc\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
    if (body.soul !== undefined) resetTaskSession(botTaskId(id));
    return NextResponse.json({ bot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "\u30dc\u30c3\u30c8\u8a2d\u5b9a\u304c\u4e0d\u6b63\u3067\u3059";
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  for (const task of listTasks(true, "bot").filter((item) => item.botId === id)) await destroyTask(task.id);
  const deleted = deleteBot(id);
  return deleted ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "\u30dc\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}

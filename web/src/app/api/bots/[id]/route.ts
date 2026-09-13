import { NextRequest, NextResponse } from "next/server";
import { BOT_TOOL_NAMES, deleteBot, getBot, normalizeBotSkills, patchBot, botTaskId } from "@/lib/bots";
import { destroyTask, requestBotSoulReload, resetTaskConversation, resetTaskSession, setBotTools, setTaskModel, setTaskThinkingLevel } from "@/lib/pi/harness";
import { validateBotSoulContent } from "@/lib/pi/bot-soul-tool";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { isAvatarColor, isAvatarEyeColor, isAvatarImage, isAvatarShape } from "@/lib/bot-avatar";
import { isAbsolutePath } from "@/lib/paths";
import { listTasks } from "@/lib/store";
import { listRooms, patchRoom } from "@/lib/rooms";
import type { BotSkillsConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function idOf(params: Promise<{ id: string }>) { return (await params).id; }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bot = getBot(await idOf(params));
  if (!bot) return NextResponse.json({ error: "\u30dc\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
  // Loading a Bot also refreshes an already-live session after legacy tool migration.
  setBotTools(bot.id, bot.tools ?? []);
  return NextResponse.json({ bot });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const hasModel = body?.model !== undefined;
  const hasTtsVoice = body?.ttsVoice !== undefined;
  const hasThinkingLevel = body?.thinkingLevel !== undefined;
  const hasSkills = body?.skills !== undefined;
  const hasTools = body?.tools !== undefined;
  const tools = hasTools && Array.isArray(body?.tools) ? [...new Set((body.tools as unknown[]).filter((item): item is string => typeof item === "string"))] : undefined;
  const validTools = !hasTools || (Array.isArray(body?.tools) && tools?.every((tool) => (BOT_TOOL_NAMES as readonly string[]).includes(tool)));
  const hasExtraRoots = body?.extraRoots !== undefined;
  const hasNotificationsEnabled = body?.notificationsEnabled !== undefined;
  const hasCodeAutoApprove = body?.codeAutoApprove !== undefined;
  const hasPermissionMode = body?.permissionMode !== undefined;
  const hasEnabled = body?.enabled !== undefined;
  const hasResetMessages = body?.resetMessages !== undefined;
  const soulValidationError = body?.soul === undefined ? null : validateBotSoulContent(body.soul);
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
    (body.label !== undefined && typeof body.label !== "string") ||
    soulValidationError !== null ||
    (body.avatarColor !== undefined && !isAvatarColor(body.avatarColor)) ||
    (body.avatarShape !== undefined && !isAvatarShape(body.avatarShape)) ||
    (body.avatarEyeColor !== undefined && body.avatarEyeColor !== null && !isAvatarEyeColor(body.avatarEyeColor)) ||
    (body.avatarGlasses !== undefined && typeof body.avatarGlasses !== "boolean") ||
    (body.avatarMustache !== undefined && typeof body.avatarMustache !== "boolean") ||
    (body.avatarImage !== undefined && body.avatarImage !== null && !isAvatarImage(body.avatarImage)) ||
    (hasNotificationsEnabled && typeof body.notificationsEnabled !== "boolean") ||
    (hasCodeAutoApprove && typeof body.codeAutoApprove !== "boolean") ||
    (hasPermissionMode && !["allow", "ask", "deny"].includes(body.permissionMode as string)) ||
    (hasEnabled && typeof body.enabled !== "boolean") ||
    (hasResetMessages && body.resetMessages !== true) ||
    (hasModel && (typeof body.model !== "string" || !body.model.trim())) ||
    (hasTtsVoice && body.ttsVoice !== null && typeof body.ttsVoice !== "string") ||
    (hasThinkingLevel && !isThinkingLevel(body.thinkingLevel)) ||
    !validSkills ||
    !validTools ||
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
    if (isAvatarShape(body.avatarShape)) patch.avatarShape = body.avatarShape;
    if (body.avatarEyeColor !== undefined) patch.avatarEyeColor = body.avatarEyeColor as string | null;
    if (typeof body.avatarGlasses === "boolean") patch.avatarGlasses = body.avatarGlasses;
    if (typeof body.avatarMustache === "boolean") patch.avatarMustache = body.avatarMustache;
    if (body.avatarImage !== undefined) patch.avatarImage = body.avatarImage as string | null;
    if (hasNotificationsEnabled) patch.notificationsEnabled = body.notificationsEnabled as boolean;
    if (hasCodeAutoApprove) patch.codeAutoApprove = body.codeAutoApprove as boolean;
    if (hasPermissionMode) patch.permissionMode = body.permissionMode as "allow" | "ask" | "deny";
    if (hasEnabled) patch.enabled = body.enabled as boolean;
    if (hasSkills) patch.skills = skills as BotSkillsConfig;
    if (hasTools) patch.tools = tools as Parameters<typeof patchBot>[1]["tools"];
    if (hasExtraRoots) patch.extraRoots = extraRoots ?? [];
    if (body.soul !== undefined) patch.soul = body.soul as string;
    if (hasTtsVoice) patch.ttsVoice = typeof body.ttsVoice === "string" ? body.ttsVoice.trim() || null : null;
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
    if (hasTools) setBotTools(id, bot.tools ?? []);
    if (hasResetMessages) await resetTaskConversation(botTaskId(id));
    // SOUL and the per-Bot skill allowlist both shape the system prompt. Do not dispose a working
    // session: mark all local Bot conversations and rebuild them at their next safe turn boundary.
    else if (body.soul !== undefined) requestBotSoulReload(id);
    else if (hasSkills) resetTaskSession(botTaskId(id));
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
  if (!deleted) return NextResponse.json({ error: "\u30dc\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
  // A deleted Bot must not linger as a Room member: a dangling id keeps a member slot and shows up
  // in every room snapshot until someone happens to re-save the membership.
  for (const room of listRooms()) {
    if (room.members.includes(id)) patchRoom(room.id, { members: room.members.filter((member) => member !== id) });
  }
  return NextResponse.json({ ok: true });
}

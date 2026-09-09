import { NextRequest, NextResponse } from "next/server";
import { createBot, listBots, patchBot } from "@/lib/bots";
import { listTasks } from "@/lib/store";
import { botTemplateById } from "@/lib/bot-marketplace";
import { getSetting } from "@/lib/pi/web-settings";
import { parseBotDefaultPermission, parseBotDefaultThinking, BOT_DEFAULT_PERMISSION_KEY, BOT_DEFAULT_THINKING_KEY } from "@/lib/bot-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const counts = new Map<string, number>();
  for (const task of listTasks()) {
    if (task.status === "working" && task.botId) counts.set(task.botId, (counts.get(task.botId) ?? 0) + 1);
  }
  return NextResponse.json({ bots: listBots().map((bot) => ({ ...bot, codeSessionCount: counts.get(bot.id) ?? 0 })) });
}
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; templateId?: unknown } | null;
  if (body?.name !== undefined && typeof body.name !== "string") return NextResponse.json({ error: "invalid name" }, { status: 400 });
  if (body?.templateId !== undefined && typeof body.templateId !== "string") return NextResponse.json({ error: "invalid template" }, { status: 400 });
  const template = typeof body?.templateId === "string" ? botTemplateById(body.templateId) : undefined;
  if (body?.templateId !== undefined && !template) return NextResponse.json({ error: "unknown template" }, { status: 400 });
  const created = createBot({ name: body?.name ?? template?.name, permissionMode: parseBotDefaultPermission(getSetting(BOT_DEFAULT_PERMISSION_KEY)), thinkingLevel: parseBotDefaultThinking(getSetting(BOT_DEFAULT_THINKING_KEY)) });
  const bot = template ? patchBot(created.id, { label: template.label, soul: template.soul }) ?? created : created;
  return NextResponse.json({ bot }, { status: 201 });
}

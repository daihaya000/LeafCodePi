import { NextRequest, NextResponse } from "next/server";
import { createBot, isBotNameWithinSize, listBots, patchBot } from "@/lib/bots";
import { relayBotList } from "@/lib/backend-relay";
import { listTasks } from "@/lib/store";
import { botTemplateById } from "@/lib/bot-marketplace";
import { getSetting } from "@/lib/pi/web-settings";
import { parseBotDefaultPermission, parseBotDefaultThinking, BOT_DEFAULT_PERMISSION_KEY, BOT_DEFAULT_THINKING_KEY } from "@/lib/bot-settings";
import { botsWithCodeSessionCounts } from "@backend-core/bot-session-counts.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // 中継が有効ならBackendのBotビュー（同じ設定ファイル＋同じ稼働数ルール）を使う。失敗時は従来経路へ。
  const relayed = await relayBotList();
  if (relayed) return NextResponse.json({ bots: relayed });
  // 稼働数はcoreの規則（workingのみ・botId優先）で数える。
  return NextResponse.json({ bots: botsWithCodeSessionCounts(listBots(), listTasks()) });
}
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; templateId?: unknown } | null;
  if (body?.name !== undefined && (typeof body.name !== "string" || !isBotNameWithinSize(body.name))) return NextResponse.json({ error: "invalid name" }, { status: 400 });
  if (body?.templateId !== undefined && typeof body.templateId !== "string") return NextResponse.json({ error: "invalid template" }, { status: 400 });
  const template = typeof body?.templateId === "string" ? botTemplateById(body.templateId) : undefined;
  if (body?.templateId !== undefined && !template) return NextResponse.json({ error: "unknown template" }, { status: 400 });
  const created = createBot({ name: body?.name ?? template?.name, permissionMode: parseBotDefaultPermission(getSetting(BOT_DEFAULT_PERMISSION_KEY)), thinkingLevel: parseBotDefaultThinking(getSetting(BOT_DEFAULT_THINKING_KEY)) });
  const bot = template ? patchBot(created.id, { label: template.label, soul: template.soul }) ?? created : created;
  return NextResponse.json({ bot }, { status: 201 });
}

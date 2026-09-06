import { NextRequest, NextResponse } from "next/server";
import { createBot, listBots } from "@/lib/bots";
import { getSetting } from "@/lib/pi/web-settings";
import { parseBotDefaultPermission, parseBotDefaultThinking, BOT_DEFAULT_PERMISSION_KEY, BOT_DEFAULT_THINKING_KEY } from "@/lib/bot-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return NextResponse.json({ bots: listBots() }); }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  if (body?.name !== undefined && typeof body.name !== "string") return NextResponse.json({ error: "invalid name" }, { status: 400 });
  return NextResponse.json({ bot: createBot({ name: body?.name, permissionMode: parseBotDefaultPermission(getSetting(BOT_DEFAULT_PERMISSION_KEY)), thinkingLevel: parseBotDefaultThinking(getSetting(BOT_DEFAULT_THINKING_KEY)) }) }, { status: 201 });
}

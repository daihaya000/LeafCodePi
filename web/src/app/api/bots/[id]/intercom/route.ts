import { NextRequest, NextResponse } from "next/server";
import { getBot } from "@/lib/bots";
import { getBotIntercomInbox, markBotIntercomInboxRead } from "@/lib/bot-intercom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function idOf(params: Promise<{ id: string }>) {
  return (await params).id;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  if (!getBot(id)) return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
  return NextResponse.json({ inbox: getBotIntercomInbox(id) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  if (!getBot(id)) return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "read") {
    return NextResponse.json({ error: "内線受信箱の操作が不正です" }, { status: 400 });
  }
  return NextResponse.json({ inbox: markBotIntercomInboxRead(id) });
}

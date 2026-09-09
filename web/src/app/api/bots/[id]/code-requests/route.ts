import { NextRequest, NextResponse } from "next/server";
import { getBot } from "@/lib/bots";
import { listBotCodeRequests } from "@/lib/pi/bot-code-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!getBot(id)) return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
  return NextResponse.json({ requests: listBotCodeRequests(id) });
}

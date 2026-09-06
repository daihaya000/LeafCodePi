import { NextRequest, NextResponse } from "next/server";
import { createBot, listBots } from "@/lib/bots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return NextResponse.json({ bots: listBots() }); }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  if (body?.name !== undefined && typeof body.name !== "string") return NextResponse.json({ error: "invalid name" }, { status: 400 });
  return NextResponse.json({ bot: createBot({ name: body?.name }) }, { status: 201 });
}

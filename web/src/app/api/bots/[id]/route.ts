import { NextRequest, NextResponse } from "next/server";
import { deleteBot, getBot, patchBot } from "@/lib/bots";
import { resetTaskSession } from "@/lib/pi/harness";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
async function idOf(params: Promise<{ id: string }>) { return (await params).id; }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bot = getBot(await idOf(params));
  return bot ? NextResponse.json({ bot }) : NextResponse.json({ error: "Bot not found" }, { status: 404 });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params); const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (body.name !== undefined && typeof body.name !== "string") || (body.soul !== undefined && typeof body.soul !== "string")) return NextResponse.json({ error: "invalid bot patch" }, { status: 400 });
  const patch: { name?: string; soul?: string } = {};
  if (body.name !== undefined) patch.name = body.name as string;
  if (body.soul !== undefined) patch.soul = body.soul as string;
  const bot = patchBot(id, patch);
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  if (body.soul !== undefined) resetTaskSession(`bot:${id}`);
  return NextResponse.json({ bot });
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params); const deleted = deleteBot(id);
  return deleted ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Bot not found" }, { status: 404 });
}

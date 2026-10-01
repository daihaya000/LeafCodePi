import { NextRequest, NextResponse } from "next/server";
import { getBot } from "@/lib/bots";
import { setBotTools } from "@/lib/pi/harness";
import { handleBotDelete, handleBotPatch, hasPrivilegedBotMutation } from "@/lib/bot-admin";
import { isWebUiRequestAuthorized } from "@/lib/webui-auth";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardBotAdmin } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function idOf(params: Promise<{ id: string }>) { return (await params).id; }

/**
 * Settings changes and deletion stop Room turns, Code sessions and conversations, all of which the
 * owning Backend holds. It runs the same handlers and the answer is replayed unchanged; a Backend
 * that cannot answer is a 502, never a local fallback.
 */
async function adminOnBackend(
  id: string,
  request: { action: "patch"; body: unknown } | { action: "delete" },
): Promise<NextResponse> {
  const forwarded = await forwardBotAdmin(id, request);
  if (!forwarded.ok) {
    return NextResponse.json(
      { error: "Backendで実行できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
      { status: 502 },
    );
  }
  return NextResponse.json(forwarded.body, { status: forwarded.status });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bot = getBot(await idOf(params));
  if (!bot) return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
  // Loading a Bot also refreshes an already-live session after legacy tool migration. The live
  // sessions belong to the owning Backend, so a client has none to refresh.
  if (!localRuntimeBlocked()) setBotTools(bot.id, bot.tools ?? []);
  return NextResponse.json({ bot });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  const parsed: unknown = await req.json().catch(() => null);
  // Standing Code approval is a privileged mutation (same bar as Room codeAutoApprove); the token is
  // checked here because the owner behind the forward trusts its caller.
  if (hasPrivilegedBotMutation(parsed) && !isWebUiRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (localRuntimeBlocked()) return await adminOnBackend(id, { action: "patch", body: parsed });
  const result = await handleBotPatch(id, parsed);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  if (localRuntimeBlocked()) return await adminOnBackend(id, { action: "delete" });
  const result = await handleBotDelete(id);
  return NextResponse.json(result.body, { status: result.status });
}

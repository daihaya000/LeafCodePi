import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getBot } from "@/lib/bots";
import { getBotIntercomInbox, markBotIntercomInboxRead } from "@/lib/bot-intercom";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  assertConfigurationOwner();
  const { id } = await params;
  if (!getBot(id)) return Response.json({ error: "ボットが見つかりません" }, { status: 404 });
  return Response.json({ inbox: getBotIntercomInbox(id) });
}
export async function PATCH(request: Request, { params }: Context) {
  assertConfigurationOwner();
  const { id } = await params;
  if (!getBot(id)) return Response.json({ error: "ボットが見つかりません" }, { status: 404 });
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== "read") return Response.json({ error: "内線受信箱の操作が不正です" }, { status: 400 });
  // Timestamp and Bot scope are always owner-derived, never HTTP body authority.
  return Response.json({ inbox: markBotIntercomInboxRead(id) });
}

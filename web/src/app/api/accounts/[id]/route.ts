import { NextRequest, NextResponse } from "next/server";
import { deleteAccount, patchAccount } from "@/lib/accounts";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** アカウントの表示名・メモを更新する（providers は作成時確定のため変更不可）。 */
export async function PATCH(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    if ("providers" in body) {
      return NextResponse.json(
        { error: "providers は変更できません。アカウントを作り直してください" },
        { status: 400 },
      );
    }
    // 未指定のキーは未変更扱い（note の意図しない消去を防ぐため "in" で判定）
    const patch: { label?: unknown; note?: unknown } = {};
    if ("label" in body) patch.label = body.label;
    if ("note" in body) patch.note = body.note;
    if (!("label" in patch) && !("note" in patch)) {
      return NextResponse.json({ error: "label か note を指定してください" }, { status: 400 });
    }
    const account = patchAccount(id, patch);
    return NextResponse.json({ account });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** アカウントを削除する（実行中タスクから参照されている間は 409）。 */
export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    deleteAccount(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createAccount, listAccounts, reorderAccounts } from "@/lib/accounts";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 登録済みアカウントの一覧。 */
export async function GET() {
  return NextResponse.json({ accounts: listAccounts() });
}

/** アカウント一覧の表示順を更新する。 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    const accounts = reorderAccounts(body.accountOrder);
    return NextResponse.json({ accounts });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** アカウントを作成する（label・providers・任意 note）。 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    const account = createAccount({
      label: body.label,
      providers: body.providers,
      note: body.note,
    });
    return NextResponse.json({ account });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

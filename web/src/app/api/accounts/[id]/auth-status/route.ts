import { NextRequest, NextResponse } from "next/server";
import { accountStoredProviders, getAccount, resolvePiAgentDir } from "@/lib/accounts";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * アカウントの auth.json に保存済みのプロバイダー一覧（認証バッジ表示用）。
 * ランタイムを起動しない軽量なファイル読み。未ログイン・破損時は空配列。
 */
export async function GET(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    if (!getAccount(id)) {
      return NextResponse.json({ error: "アカウントが見つかりません" }, { status: 404 });
    }
    const agentDir = await resolvePiAgentDir();
    return NextResponse.json({ providers: accountStoredProviders(id, agentDir) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { listProviderAuth, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * プロバイダー認証一覧。`?accountId=` でアカウントを指定できる
 * （docs/plans/multi-account.md）。Phase 3〜5 は既定ランタイムのみのため
 * パラメータの解決は Phase 6 で接続し、それまでは従来どおり default を返す。
 */
export async function GET(req: NextRequest) {
  try {
    // Phase 6 で getRuntimeFor(accountId) 解決に接続するまでの受け口（現状 default のみ）。
    void req.nextUrl.searchParams.get("accountId");
    return NextResponse.json({ providers: await listProviderAuth() });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

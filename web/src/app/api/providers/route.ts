import { NextRequest, NextResponse } from "next/server";
import { listProviderAuth, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * プロバイダー認証一覧。`?accountId=` でアカウント別 runtime を指定できる。
 */
export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get("accountId");
    return NextResponse.json({ providers: await listProviderAuth(accountId) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

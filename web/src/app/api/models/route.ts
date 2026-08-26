import { NextRequest, NextResponse } from "next/server";
import { listModels, jsonError } from "@/lib/pi/harness";
import { getCachedUsage } from "@/lib/codexbar/cache";
import { attachCodexBarUsage } from "./map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the aggregate cache only — never fetch here. A short-timeout
 * fetchNativeUsage aborts slow providers mid-flight and poisons their
 * per-provider caches with errors. The CodexBar widget (~5min poll) keeps
 * the cache warm; allow up to 30 min stale for dropdown coloring.
 */
const USAGE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * モデル一覧。`?accountId=` でアカウント別のモデル解決を受け付ける
 * （docs/plans/multi-account.md）。Phase 6 で getRuntimeFor(accountId) に接続するまで
 * は従来どおり既定ランタイムの一覧を返す。
 */
export async function GET(req: NextRequest) {
  try {
    void req.nextUrl.searchParams.get("accountId");
    const models = await listModels();
    const providers = getCachedUsage(Date.now(), USAGE_MAX_AGE_MS)?.providers ?? [];
    return NextResponse.json({ models: attachCodexBarUsage(models, providers) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

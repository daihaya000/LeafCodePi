import { NextRequest, NextResponse } from "next/server";
import { listAccounts } from "@/lib/accounts";
import { listModels, listModelsForAccounts, jsonError } from "@/lib/pi/harness";
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
 * モデル一覧。アカウントが登録されていれば既定 + 各アカウントの対象プロバイダの
 * モデルをまとめて返す。アカウントのモデルには accountId / accountLabel が付く
 * （Home でアカウントをプロバイダ枠として表示するため）。レガシーの `?accountId=` は
 * 互換のため受けるだけ。
 */
export async function GET(req: NextRequest) {
  try {
    void req.nextUrl.searchParams.get("accountId");
    const accounts = listAccounts();
    const models =
      accounts.length === 0
        ? await listModels()
        : await listModelsForAccounts(
            accounts.map((account) => ({
              id: account.id,
              label: account.label,
              providers: account.providers,
            })),
          );
    const providers = getCachedUsage(Date.now(), USAGE_MAX_AGE_MS)?.providers ?? [];
    return NextResponse.json({ models: attachCodexBarUsage(models, providers) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

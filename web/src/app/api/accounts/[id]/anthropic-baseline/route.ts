import { NextRequest, NextResponse } from "next/server";
import { accountAuthPath, getAccount, resolvePiAgentDir } from "@/lib/accounts";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { writeAnthropicCreditBaseline } from "@/lib/codexbar/providers/anthropic";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 基準残高の上限（入力ミスで％が壊れないようにするための sanity check）。 */
const MAX_BASELINE_USD = 1_000_000;

function requireAnthropicAccount(id: string): void {
  const account = getAccount(id);
  if (!account) {
    throw Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
  }
  if (!account.providers.includes("anthropic")) {
    throw Object.assign(new Error("このアカウントは Anthropic に対応していません"), {
      status: 400,
    });
  }
}

/**
 * API キー口座の基準残高（プリペイド購入額 USD）を保存する。
 * 残高から使用％を算出するためだけに使い、認証には使わない。
 */
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAnthropicAccount(id);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    // 文字列や真偽値を USD として受け付けない（`Number(true)` = 1 等の偶発的な受理を防ぐ）。
    const baselineUsd = body?.baselineUsd;
    if (
      typeof baselineUsd !== "number" ||
      !Number.isFinite(baselineUsd) ||
      baselineUsd <= 0
    ) {
      return NextResponse.json(
        { error: "baselineUsd は 0 より大きい数値で指定してください" },
        { status: 400 },
      );
    }
    if (baselineUsd > MAX_BASELINE_USD) {
      return NextResponse.json(
        { error: `baselineUsd は ${MAX_BASELINE_USD} 以下で指定してください` },
        { status: 400 },
      );
    }
    const agentDir = await resolvePiAgentDir();
    writeAnthropicCreditBaseline(accountAuthPath(id, agentDir), baselineUsd);
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:anthropic`);
    return NextResponse.json({ ok: true, baselineUsd });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** 基準残高を解除する（使用％を出さず残高だけ表示に戻す）。 */
export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAnthropicAccount(id);
    const agentDir = await resolvePiAgentDir();
    writeAnthropicCreditBaseline(accountAuthPath(id, agentDir), null);
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:anthropic`);
    return NextResponse.json({ ok: true, baselineUsd: null });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

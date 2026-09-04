import { NextRequest, NextResponse } from "next/server";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { ProviderError } from "@/lib/codexbar/types";
import {
  withOpenaiCodexWhamAuth,
} from "@/lib/codexbar/providers/openai-codex";
import {
  consumeCodexResetCredit,
  describeResetConsumeCode,
  listCodexResetCredits,
} from "@/lib/codexbar/providers/openai-codex-reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status) && status >= 400 && status < 600) return status;
  }
  if (error instanceof ProviderError && error.message === "__unauthorized__") {
    return 401;
  }
  return 503;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ProviderError && error.message === "__unauthorized__") {
    return "Codex の OAuth トークンが無効か期限切れです。再ログインしてください。";
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * GET /api/codexbar/reset-credits — list banked Codex rate-limit resets.
 * Query: ?accountId=<leafcode-account-id> (optional; default/CLI auth when omitted).
 */
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId");
  try {
    const { result, session } = await withOpenaiCodexWhamAuth(
      accountId,
      (credentials, signal) => listCodexResetCredits(credentials, signal),
    );
    return NextResponse.json({
      availableCount: result.availableCount,
      credits: result.credits,
      accountId: session.leafcodeAccountId,
    });
  } catch (error) {
    const status = errorStatus(error);
    return NextResponse.json(
      { error: errorMessage(error, "リセット権の取得に失敗しました") },
      { status: status === 404 ? 404 : status === 401 || status === 403 ? status : 503 },
    );
  }
}

type ConsumeBody = {
  creditId?: unknown;
  accountId?: unknown;
  redeemRequestId?: unknown;
};

/**
 * POST /api/codexbar/reset-credits — redeem one banked reset.
 * Body: { creditId: string, accountId?: string, redeemRequestId?: string }
 *
 * Business outcomes (nothing_to_reset / no_credit) return HTTP 200 with ok:false.
 * Auth failures return 401/403. Transport/provider errors return 503.
 */
export async function POST(req: NextRequest) {
  let body: ConsumeBody;
  try {
    body = (await req.json()) as ConsumeBody;
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400 });
  }

  const creditId =
    typeof body.creditId === "string" ? body.creditId.trim() : "";
  if (!creditId) {
    return NextResponse.json({ error: "creditId が必要です" }, { status: 400 });
  }
  const accountId =
    typeof body.accountId === "string" && body.accountId.trim()
      ? body.accountId.trim()
      : null;
  const redeemRequestId =
    typeof body.redeemRequestId === "string" && body.redeemRequestId.trim()
      ? body.redeemRequestId.trim()
      : undefined;

  try {
    const { result, session } = await withOpenaiCodexWhamAuth(
      accountId,
      (credentials, signal) =>
        consumeCodexResetCredit(credentials, {
          creditId,
          redeemRequestId,
          signal,
        }),
    );

    if (result.ok) {
      invalidateCachedUsage();
      clearProviderCache(session.instanceId);
      // Also clear aggregate default/all keys that may hold the same provider.
      clearProviderCache("default:openai-codex");
    }

    return NextResponse.json({
      ok: result.ok,
      code: result.code,
      message: describeResetConsumeCode(result.code),
      windowsReset: result.windowsReset,
      creditId: result.creditId ?? creditId,
      accountId: session.leafcodeAccountId,
    });
  } catch (error) {
    const status = errorStatus(error);
    return NextResponse.json(
      { error: errorMessage(error, "リセット権の消費に失敗しました") },
      { status: status === 404 ? 404 : status === 401 || status === 403 ? status : 503 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  accountAuthPath,
  getAccount,
  isAccountEnabled,
  resolvePiAgentDir,
} from "@/lib/accounts";
import { extractAnthropicConsoleSession } from "@/lib/codexbar/browser-cookies";
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
import {
  consumeClaudeResetGrant,
  describeClaudeResetCode,
  listClaudeResetGrants,
} from "@/lib/codexbar/providers/anthropic-reset";

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

function errorResponse(error: unknown, fallback: string): Response {
  const status = errorStatus(error);
  return NextResponse.json(
    { error: errorMessage(error, fallback) },
    { status: status === 404 ? 404 : status === 401 || status === 403 ? status : 503 },
  );
}

/** accountId 指定時は存在確認し、一時停止アカウントは 409 で拒否する。 */
function assertAccountUsable(accountId: string | null): Response | null {
  if (!accountId) return null;
  const account = getAccount(accountId);
  if (!account) {
    return NextResponse.json(
      { error: "アカウントが見つかりません" },
      { status: 404 },
    );
  }
  if (!isAccountEnabled(account)) {
    return NextResponse.json(
      { error: "一時停止中のアカウントです" },
      { status: 409 },
    );
  }
  return null;
}

/** Claude は claude.ai cookie 必須。アカウント指定時は共有 cookie へフォールバックしない。 */
async function claudeSession(accountId: string | null) {
  const authPath = accountId
    ? accountAuthPath(accountId, await resolvePiAgentDir())
    : null;
  const session = extractAnthropicConsoleSession({ authPath });
  if (!session) {
    throw Object.assign(
      new Error(
        "Claude のリセット権には claude.ai の cookie が必要です。claude.ai にログインしたブラウザの cookie を登録してください。",
      ),
      { status: 401 },
    );
  }
  return session;
}

function isAnthropic(provider: unknown): boolean {
  return provider === "anthropic";
}

/**
 * GET /api/codexbar/reset-credits — list banked rate-limit resets.
 * Query: ?accountId=<leafcode-account-id>&provider=openai-codex|anthropic
 * (accountId optional; default/CLI auth when omitted. provider defaults to openai-codex).
 */
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId");
  const refused = assertAccountUsable(accountId);
  if (refused) return refused;
  try {
    if (isAnthropic(req.nextUrl.searchParams.get("provider"))) {
      const result = await listClaudeResetGrants(await claudeSession(accountId));
      return NextResponse.json({
        availableCount: result.availableCount,
        // Claude は next_grant_id しか消費できないため、今使えるものだけ返す。
        credits: result.credits
          .filter((c) => c.status === "available")
          .map((c) => ({
            id: c.id,
            title: c.title,
            description: null,
            expiresAt: c.expiresAt,
            grantedAt: c.grantedAt,
            status: c.status,
          })),
        accountId,
      });
    }
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
    return errorResponse(error, "リセット権の取得に失敗しました");
  }
}

type ConsumeBody = {
  creditId?: unknown;
  accountId?: unknown;
  redeemRequestId?: unknown;
  provider?: unknown;
};

/**
 * POST /api/codexbar/reset-credits — redeem one banked reset.
 * Body: { creditId: string, accountId?: string, redeemRequestId?: string, provider?: "anthropic" }
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

  const refused = assertAccountUsable(accountId);
  if (refused) return refused;

  try {
    if (isAnthropic(body.provider)) {
      const result = await consumeClaudeResetGrant(await claudeSession(accountId), {
        grantId: creditId,
        requestId: redeemRequestId,
      });
      if (result.ok) {
        invalidateCachedUsage();
        if (accountId) clearProviderCache(`account:${accountId}:anthropic`);
        clearProviderCache("default:anthropic");
      }
      return NextResponse.json({
        ok: result.ok,
        code: result.code,
        message: describeClaudeResetCode(result.code),
        windowsReset: null,
        creditId: result.grantId ?? creditId,
        accountId,
      });
    }

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
    return errorResponse(error, "リセット権の消費に失敗しました");
  }
}

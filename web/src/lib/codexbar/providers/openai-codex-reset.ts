/**
 * OpenAI Codex banked rate-limit reset (WHAM) adapter.
 *
 * GET  /wham/rate-limit-reset-credits
 * POST /wham/rate-limit-reset-credits/consume
 *
 * Same OAuth as usage: Authorization Bearer + ChatGPT-Account-Id.
 */

import { randomUUID } from "node:crypto";
import { ProviderError } from "@/lib/codexbar/types";
import {
  asRecord,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import type { CodexWhamCredentials } from "@/lib/codexbar/providers/openai-codex";

const BASE = "https://chatgpt.com/backend-api";
const LIST_URL = `${BASE}/wham/rate-limit-reset-credits`;
const CONSUME_URL = `${BASE}/wham/rate-limit-reset-credits/consume`;

export type CodexResetCredit = {
  id: string;
  resetType: string | null;
  status: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
};

export type CodexResetCreditList = {
  credits: CodexResetCredit[];
  availableCount: number;
};

export type CodexResetConsumeCode =
  | "reset"
  | "already_redeemed"
  | "no_credit"
  | "nothing_to_reset"
  | (string & {});

export type CodexResetConsumeResult = {
  ok: boolean;
  code: CodexResetConsumeCode;
  status: number;
  windowsReset: number | null;
  creditId: string | null;
};

function whamHeaders(
  credentials: CodexWhamCredentials,
  json: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
  };
  if (credentials.chatgptAccountId) {
    headers["ChatGPT-Account-Id"] = credentials.chatgptAccountId;
  }
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function parseCredit(value: unknown): CodexResetCredit | null {
  const root = asRecord(value);
  if (!root) return null;
  const id = typeof root.id === "string" ? root.id : null;
  if (!id) return null;
  const str = (key: string): string | null =>
    typeof root[key] === "string" ? (root[key] as string) : null;
  return {
    id,
    resetType: str("reset_type"),
    status: str("status"),
    grantedAt: str("granted_at"),
    expiresAt: str("expires_at"),
    title: str("title"),
    description: str("description"),
  };
}

/** Sort available credits so the earliest expiration is first. */
export function sortResetCreditsByExpiry(
  credits: readonly CodexResetCredit[],
): CodexResetCredit[] {
  return [...credits].sort((a, b) => {
    const aExp = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
    const bExp = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
    const aOk = Number.isFinite(aExp) ? aExp : Number.POSITIVE_INFINITY;
    const bOk = Number.isFinite(bExp) ? bExp : Number.POSITIVE_INFINITY;
    return aOk - bOk;
  });
}

export function parseCodexResetCreditsJson(json: string): CodexResetCreditList {
  const root = asRecord(JSON.parse(json));
  if (!root) throw new ProviderError("リセット権の応答形式が不正です。");
  const credits = Array.isArray(root.credits)
    ? root.credits.map(parseCredit).filter((c): c is CodexResetCredit => c !== null)
    : [];
  const reported = flexibleNumber(root.available_count);
  const availableFromList = credits.filter(
    (c) => (c.status ?? "available") === "available",
  ).length;
  const availableCount =
    reported !== null ? Math.max(0, Math.trunc(reported)) : availableFromList;
  return {
    credits: sortResetCreditsByExpiry(
      credits.filter((c) => (c.status ?? "available") === "available"),
    ),
    availableCount,
  };
}

export async function listCodexResetCredits(
  credentials: CodexWhamCredentials,
  signal?: AbortSignal,
): Promise<CodexResetCreditList> {
  const { status, body, ok } = await fetchText(LIST_URL, {
    headers: whamHeaders(credentials, false),
    signal,
  });
  if (status === 401 || status === 403) {
    throw new ProviderError("__unauthorized__");
  }
  if (!ok) throw new ProviderError(`リセット権の取得に失敗しました（${status}）。`);
  return parseCodexResetCreditsJson(body);
}

export function parseCodexResetConsumeJson(
  json: string,
  httpStatus: number,
): CodexResetConsumeResult {
  let root: Record<string, unknown> | null = null;
  try {
    root = asRecord(JSON.parse(json));
  } catch {
    root = null;
  }
  const code =
    root && typeof root.code === "string"
      ? root.code
      : httpStatus >= 200 && httpStatus < 300
        ? "reset"
        : `http_${httpStatus}`;
  const credit = root ? asRecord(root.credit) : null;
  const windowsReset = root ? flexibleNumber(root.windows_reset) : null;
  return {
    ok: code === "reset" || code === "already_redeemed",
    code,
    status: httpStatus,
    windowsReset: windowsReset !== null ? Math.trunc(windowsReset) : null,
    creditId: credit && typeof credit.id === "string" ? credit.id : null,
  };
}

export async function consumeCodexResetCredit(
  credentials: CodexWhamCredentials,
  options: {
    creditId: string;
    redeemRequestId?: string;
    signal?: AbortSignal;
  },
): Promise<CodexResetConsumeResult> {
  const redeemRequestId = options.redeemRequestId?.trim() || randomUUID();
  const { status, body, ok } = await fetchText(CONSUME_URL, {
    method: "POST",
    headers: whamHeaders(credentials, true),
    body: JSON.stringify({
      credit_id: options.creditId,
      redeem_request_id: redeemRequestId,
      ...(credentials.chatgptAccountId
        ? { account_id: credentials.chatgptAccountId }
        : {}),
    }),
    signal: options.signal,
  });
  if (status === 401 || status === 403) {
    throw new ProviderError("__unauthorized__");
  }
  if (!ok && !body.trim()) {
    throw new ProviderError(`リセット権の消費に失敗しました（${status}）。`);
  }
  return parseCodexResetConsumeJson(body || "{}", status);
}

export type AutoConsumeExpiringResult = {
  /** Credits whose expiry falls inside the window. */
  expiring: number;
  /** Credits actually redeemed. */
  consumed: number;
  codes: CodexResetConsumeCode[];
};

/**
 * Redeem available credits that would expire within `windowMs` (earliest expiry
 * first). Deterministic redeem_request_id (`auto-<creditId>`) makes retries safe
 * via `already_redeemed`. Stops at `nothing_to_reset`/`no_credit` since further
 * consumes cannot succeed.
 */
export async function autoConsumeExpiringResetCredits(
  credentials: CodexWhamCredentials,
  options: { windowMs: number; now?: number; signal?: AbortSignal },
): Promise<AutoConsumeExpiringResult> {
  const now = options.now ?? Date.now();
  const list = await listCodexResetCredits(credentials, options.signal);
  const expiring = list.credits.filter((credit) => {
    if (!credit.expiresAt) return false;
    const expiresMs = Date.parse(credit.expiresAt);
    return (
      Number.isFinite(expiresMs) &&
      expiresMs >= now &&
      expiresMs - now <= options.windowMs
    );
  });
  const codes: CodexResetConsumeCode[] = [];
  let consumed = 0;
  for (const credit of expiring) {
    const result = await consumeCodexResetCredit(credentials, {
      creditId: credit.id,
      redeemRequestId: `auto-${credit.id}`,
      signal: options.signal,
    });
    codes.push(result.code);
    if (result.ok) {
      consumed += 1;
      continue;
    }
    break;
  }
  return { expiring: expiring.length, consumed, codes };
}

export function describeResetConsumeCode(code: CodexResetConsumeCode): string {
  switch (code) {
    case "reset":
      return "使用量ウィンドウをリセットしました。";
    case "already_redeemed":
      return "このリセット権は既に使用済みです（再試行として成功扱い）。";
    case "nothing_to_reset":
      return "リセット対象の使用量ウィンドウがありません。";
    case "no_credit":
      return "利用可能なリセット権がありません。";
    default:
      return `リセット権の消費結果: ${code}`;
  }
}

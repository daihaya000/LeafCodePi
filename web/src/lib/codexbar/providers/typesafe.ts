/**
 * TypeSafe（Jev）の利用額/残高表示。
 *
 * TypeSafe は公開APIに残高/クレジットエンドポイントを持たない（docs.typesafe.ai/api・/models
 * で確認済み。公開エンドポイントは POST /v1/systemone と GET /v1/models のみ）。
 * 実残高は Anthropic の Console cookie 方式と同様、console.typesafe.ai の
 * セッション cookie（session_id + organization_id）で /settings/billing の Next.js
 * Server Action（getBillingOverviewResult）を直接呼ぶ。非公開の内部APIのため、
 * TypeSafe がコンソールを再デプロイすると Next-Action ID が変わり失敗し得る
 * （その場合は例外を投げず、下記のローカル見積りへ自動フォールバックする）。
 *
 * cookie 未登録時は、自アプリが実行した /v1/systemone 呼び出しの usage（input_tokens）を
 * 公開価格（$42 / 10億入力トークン、出力トークンは無料）で積算した「推定利用額」を表示する。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import {
  ProviderError,
  type IUsageProvider,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  atomicWriteText,
  clamp,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import { readPiApiKey } from "@/lib/codexbar/pi-auth";
import { codexBarConfigDir } from "@/lib/codexbar/netscape-cookies";
import {
  createCookieHeaderForUrl,
  extractTypesafeConsoleSession,
  readTypesafeOrgId,
  type BrowserCookieSession,
} from "@/lib/codexbar/browser-cookies";

/** $42 per billion input tokens (docs.typesafe.ai/models)。出力トークンは無料。 */
export const TYPESAFE_INPUT_USD_PER_TOKEN = 42 / 1_000_000_000;

export type TypesafeUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  updatedAt: string | null;
};

function usageStorePath(): string {
  return join(dataDir(), "typesafe-usage.json");
}

function emptyTotals(): TypesafeUsageTotals {
  return { inputTokens: 0, outputTokens: 0, calls: 0, updatedAt: null };
}

/** 集計済みトークン数を読む。ファイル無し・破損時は 0 集計を返す。 */
export function readTypesafeUsageTotals(): TypesafeUsageTotals {
  try {
    const path = usageStorePath();
    if (!existsSync(path)) return emptyTotals();
    const root = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return {
      inputTokens: flexibleNumber(root.inputTokens) ?? 0,
      outputTokens: flexibleNumber(root.outputTokens) ?? 0,
      calls: flexibleNumber(root.calls) ?? 0,
      updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : null,
    };
  } catch {
    return emptyTotals();
  }
}

/**
 * 呼び出しごとにベストエフォートで積算する。カウンター読み書きの失敗は
 * 呼び出し元の Jev 判定処理を壊してはならない（常に握りつぶす）。
 */
export function recordTypesafeUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
}): void {
  try {
    const totals = readTypesafeUsageTotals();
    const next: TypesafeUsageTotals = {
      inputTokens:
        totals.inputTokens + (flexibleNumber(usage.input_tokens) ?? 0),
      outputTokens:
        totals.outputTokens + (flexibleNumber(usage.output_tokens) ?? 0),
      calls: totals.calls + 1,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteText(usageStorePath(), JSON.stringify(next, null, 2));
  } catch {
    /* usage counter は判定呼び出しを壊さない */
  }
}

export function estimatedTypesafeUsd(totals: TypesafeUsageTotals): number {
  return totals.inputTokens * TYPESAFE_INPUT_USD_PER_TOKEN;
}

export function resolveTypesafeApiKey(): string | null {
  return readPiApiKey("typesafe");
}

function typesafeSettingsPath(): string {
  return join(codexBarConfigDir(), "typesafe.json");
}

/** 実残高から使用率を出すための手入力基準残高（USD）。 */
export function readTypesafeCreditBaseline(): number | null {
  try {
    const path = typesafeSettingsPath();
    if (!existsSync(path)) return null;
    const root = JSON.parse(readFileSync(path, "utf8")) as {
      creditBaselineUsd?: unknown;
    };
    const value = flexibleNumber(root.creditBaselineUsd);
    return value !== null && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeTypesafeCreditBaseline(baselineUsd: number | null): void {
  const path = typesafeSettingsPath();
  if (baselineUsd === null || !(baselineUsd > 0)) {
    try {
      unlinkSync(path);
    } catch {
      /* already absent */
    }
    return;
  }
  atomicWriteText(
    path,
    `${JSON.stringify({ creditBaselineUsd: baselineUsd }, null, 2)}\n`,
  );
}

/** 手入力基準残高とConsole残高から、表示専用の使用率を導出する。 */
export function applyTypesafeCreditBaseline(
  snapshot: UsageSnapshot,
  baselineUsd: number | null,
): UsageSnapshot {
  if (
    baselineUsd === null ||
    !(baselineUsd > 0) ||
    snapshot.creditsBalance === null
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    creditsUsed: clamp(baselineUsd - snapshot.creditsBalance, 0, baselineUsd),
    creditsLimit: baselineUsd,
    usageDisplayOnly: true,
  };
}

function localEstimateSnapshot(): UsageSnapshot {
  const totals = readTypesafeUsageTotals();
  return {
    providerId: "typesafe",
    providerName: "TypeSafe",
    plan: null,
    accountEmail: null,
    windows: [],
    creditsEnabled: true,
    creditsTitle: "推定利用額（Jev、cookie未登録）",
    creditsUsed: estimatedTypesafeUsd(totals),
    creditsLimit: null,
    creditsBalance: null,
    creditsLabel: null,
    // 実残高ではなくローカル見積り。集計・ルーティングの判断材料に使わない。
    usageDisplayOnly: true,
    sourceLabel: "ローカル集計（$42/10億入力トークン、出力無料）",
    updatedAt: totals.updatedAt ? new Date(totals.updatedAt) : new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

/** console.typesafe.ai の billing Server Action（`/settings/billing` 上でのみ有効）。 */
const TYPESAFE_BILLING_URL = "https://console.typesafe.ai/settings/billing";
const TYPESAFE_BILLING_ACTION_NAME = "getBillingOverviewResult";
/** 既知のデプロイで使われたID。失敗時は現在のページから再解決する。 */
const TYPESAFE_BILLING_ACTION_ID =
  "00216a0f6524a89c66b80e4babe337d5f2d86e071b";
const TYPESAFE_DISCOVERY_PAGE_TIMEOUT_MS = 10_000;
const TYPESAFE_DISCOVERY_SCRIPT_TIMEOUT_MS = 5_000;
let typesafeBillingActionId = TYPESAFE_BILLING_ACTION_ID;

export type TypesafeConsoleBilling = {
  plan: string;
  spent: number;
  freeCreditsRemaining: number | null;
  purchased: number | null;
  balance: number | null;
  resetsInDays: number | null;
  cycleLabel: string | null;
};

function prettyTypesafePlan(plan: string): string {
  if (plan === "free_plan") return "Free";
  if (plan === "invoice_based") return "Invoice";
  return plan;
}

/**
 * Server Action の応答は RSC の "Flight" 行形式（`<index>:<json>` の改行区切り）。
 * インデックスはデプロイで変わり得るため固定せず、`data.billing` を含む行を探す。
 */
export function parseTypesafeBillingActionResponse(
  text: string,
): TypesafeConsoleBilling {
  for (const line of text.split("\n")) {
    const match = /^\d+:(\{.*\})\s*$/.exec(line);
    if (!match) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const billing = asRecord(asRecord(asRecord(parsed)?.data)?.billing);
    if (!billing) continue;
    const plan = typeof billing.plan === "string" ? billing.plan : null;
    const spent = flexibleNumber(billing.spent);
    if (!plan || spent === null) continue;
    return {
      plan,
      spent,
      freeCreditsRemaining: flexibleNumber(billing.freeCreditsRemaining),
      purchased: flexibleNumber(billing.purchased),
      balance: flexibleNumber(billing.balance),
      resetsInDays: flexibleNumber(billing.resetsInDays),
      cycleLabel:
        typeof billing.cycleLabel === "string" ? billing.cycleLabel : null,
    };
  }
  throw new ProviderError("TypeSafe の残高データを取得できませんでした。");
}

/** 認証済みBillingページのJSから、現在のServer Action IDを拾う。 */
export function extractTypesafeBillingActionId(text: string): string | null {
  const marker = text.indexOf(TYPESAFE_BILLING_ACTION_NAME);
  if (marker < 0) return null;
  const start = Math.max(0, marker - 2_000);
  const context = text.slice(start, Math.min(text.length, marker + 2_000));
  const markerOffset = marker - start;
  let closest: { id: string; distance: number } | null = null;
  for (const match of context.matchAll(
    /createServerReference\s*\(\s*["']([0-9a-f]{40,64})["']/gi,
  )) {
    if (match.index === undefined || !match[1]) continue;
    const distance = Math.abs(match.index - markerOffset);
    if (!closest || distance < closest.distance) {
      closest = { id: match[1], distance };
    }
  }
  return closest?.id ?? null;
}

async function discoverTypesafeBillingActionId(
  cookieHeader: string,
  signal?: AbortSignal,
): Promise<string> {
  const page = await fetchText(TYPESAFE_BILLING_URL, {
    headers: {
      Accept: "text/html",
      Cookie: cookieHeader,
      Referer: TYPESAFE_BILLING_URL,
    },
    signal,
    timeoutMs: TYPESAFE_DISCOVERY_PAGE_TIMEOUT_MS,
  });
  if (page.status === 401 || page.status === 403) {
    throw new ProviderError(
      "TypeSafe Console のセッションが期限切れです。cookie を再登録してください。",
    );
  }
  if (!page.ok) {
    throw new ProviderError(`TypeSafe Console API エラー ${page.status}。`);
  }

  const pageActionId = extractTypesafeBillingActionId(page.body);
  if (pageActionId) return pageActionId;

  const scriptSources = [
    ...page.body.matchAll(
      /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    ),
  ]
    .map((match) => match[1].replace(/&amp;/g, "&"))
    .filter((src) => src.length > 0);
  const origin = new URL(TYPESAFE_BILLING_URL).origin;
  const scriptUrls: URL[] = [];
  for (const source of new Set(scriptSources)) {
    try {
      const url = new URL(source, TYPESAFE_BILLING_URL);
      if (url.origin === origin) scriptUrls.push(url);
    } catch {
      // Ignore malformed or cross-origin asset references.
    }
  }
  const scripts = await Promise.all(
    scriptUrls.map(async (url) => {
      try {
        return await fetchText(url.href, {
          headers: { Accept: "*/*" },
          signal,
          timeoutMs: TYPESAFE_DISCOVERY_SCRIPT_TIMEOUT_MS,
        });
      } catch {
        return null;
      }
    }),
  );
  for (const script of scripts) {
    if (!script?.ok) continue;
    const actionId = extractTypesafeBillingActionId(script.body);
    if (actionId) return actionId;
  }
  throw new ProviderError(
    "TypeSafe Console のBilling用Server Actionを特定できませんでした。",
  );
}

async function fetchTypesafeConsoleBilling(
  session: BrowserCookieSession,
  signal?: AbortSignal,
): Promise<TypesafeConsoleBilling> {
  const orgId = readTypesafeOrgId(session);
  if (!orgId) {
    throw new ProviderError(
      "TypeSafe Console の cookie に組織ID（organization_id）がありません。",
    );
  }
  const cookieHeader = createCookieHeaderForUrl(session, TYPESAFE_BILLING_URL);
  if (!cookieHeader) {
    throw new ProviderError("TypeSafe Console へ送れる cookie がありません。");
  }
  const authenticatedCookieHeader = cookieHeader;
  async function request(actionId: string) {
    return fetchText(TYPESAFE_BILLING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "text/x-component",
        "Next-Action": actionId,
        Origin: "https://console.typesafe.ai",
        Referer: TYPESAFE_BILLING_URL,
        Cookie: authenticatedCookieHeader,
      },
      body: "[]",
      signal,
    });
  }

  const first = await request(typesafeBillingActionId);
  if (first.status === 401 || first.status === 403) {
    throw new ProviderError(
      "TypeSafe Console のセッションが期限切れです。cookie を再登録してください。",
    );
  }
  if (first.ok) {
    try {
      return parseTypesafeBillingActionResponse(first.body);
    } catch {
      // 形式変更も現在のAction ID再解決で回復を試みる。
    }
  } else if (first.status !== 404) {
    throw new ProviderError(`TypeSafe Console API エラー ${first.status}。`);
  }

  const actionId = await discoverTypesafeBillingActionId(
    authenticatedCookieHeader,
    signal,
  );
  typesafeBillingActionId = actionId;
  const retry = await request(actionId);
  if (retry.status === 401 || retry.status === 403) {
    throw new ProviderError(
      "TypeSafe Console のセッションが期限切れです。cookie を再登録してください。",
    );
  }
  if (!retry.ok) {
    throw new ProviderError(`TypeSafe Console API エラー ${retry.status}。`);
  }
  return parseTypesafeBillingActionResponse(retry.body);
}

export const typesafeProvider: IUsageProvider = {
  id: "typesafe",
  name: "TypeSafe",
  isConfigured() {
    return (
      resolveTypesafeApiKey() !== null || extractTypesafeConsoleSession() !== null
    );
  },
  async fetch(signal): Promise<UsageSnapshot> {
    const session = extractTypesafeConsoleSession();
    if (session) {
      try {
        const billing = await fetchTypesafeConsoleBilling(session, signal);
        return applyTypesafeCreditBaseline({
          providerId: "typesafe",
          providerName: "TypeSafe",
          plan: prettyTypesafePlan(billing.plan),
          accountEmail: null,
          windows: [],
          creditsEnabled: true,
          creditsTitle: billing.cycleLabel ? `残高（${billing.cycleLabel}）` : "残高",
          creditsUsed: billing.spent,
          creditsLimit: null,
          creditsBalance: billing.balance,
          creditsLabel: null,
          sourceLabel: "console.typesafe.ai",
          updatedAt: new Date(),
          isStale: false,
          rateLimitResetCreditsAvailable: null,
        }, readTypesafeCreditBaseline());
      } catch {
        // cookie 失効 or Next-Action ID がデプロイで変わった等。ローカル見積りへフォールバック。
      }
    }
    return localEstimateSnapshot();
  },
};

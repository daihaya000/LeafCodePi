/**
 * TypeSafe（Jev）の利用額をローカル集計で見積もって表示する。
 *
 * TypeSafe は残高/クレジットの公開APIを持たない（docs.typesafe.ai/api・/models
 * で確認済み。公開エンドポイントは POST /v1/systemone と GET /v1/models のみ）。
 * このプロバイダーは非公開のコンソールAPIを推測実装せず、自アプリが実行した
 * /v1/systemone 呼び出しの usage（input_tokens）を公開価格
 * （$42 / 10億入力トークン、出力トークンは無料）で積算した「推定利用額」を表示する。
 * 実際の口座残高ではない（TypeSafe が残高APIを公開すれば置き換える）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import type { IUsageProvider, UsageSnapshot } from "@/lib/codexbar/types";
import { atomicWriteText, flexibleNumber } from "@/lib/codexbar/utils";
import { readPiApiKey } from "@/lib/codexbar/pi-auth";

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

export const typesafeProvider: IUsageProvider = {
  id: "typesafe",
  name: "TypeSafe",
  isConfigured() {
    return resolveTypesafeApiKey() !== null;
  },
  async fetch(): Promise<UsageSnapshot> {
    const totals = readTypesafeUsageTotals();
    return {
      providerId: "typesafe",
      providerName: "TypeSafe",
      plan: null,
      accountEmail: null,
      windows: [],
      creditsEnabled: true,
      creditsTitle: "推定利用額（Jev、残高APIなし）",
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
  },
};

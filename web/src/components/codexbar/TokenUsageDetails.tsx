import type { ProviderTokenUsage, TokenUsageEstimate } from "@/lib/codexbar/token-usage-types";

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const rateFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
function tokens(value: number): string {
  return numberFormat.format(Math.round(value));
}
function compactTokens(value: number): string {
  return compactFormat.format(Math.round(value));
}

const unavailableLabel = {
  calibrating: "計測中／使用率差1%以上が必要",
  ready: "未校正",
  stale: "古い取得値",
  expired: "リセット期限経過",
  unsupported: "この利用枠は推定対象外",
  invalid: "使用率・日時を取得できない",
};
type Combined = { measuredAccounts: number; totalAccounts: number };

function estimateState(window: TokenUsageEstimate, now: number, combined?: Combined) {
  const stale = !!window.validUntil && Date.parse(window.validUntil) <= now;
  const available = !stale && (window.status === undefined || window.status === "ready") &&
    (combined !== undefined || window.tokensPerPercent !== null) && window.estimatedRemainingTokens !== null;
  return { available, status: stale ? "stale" as const : window.status ?? "calibrating" };
}

/** One compact remaining estimate; the conversion rate and caveats stay in its tooltip. */
export function TokenEstimateInline({ estimate, now, combined, showTitle = false }: {
  estimate?: TokenUsageEstimate;
  now: number;
  combined?: Combined;
  showTitle?: boolean;
}) {
  if (!estimate || !estimateState(estimate, now, combined).available) return null;
  const title = combined
    ? `推定残合計 ${tokens(estimate.estimatedRemainingTokens!)} tok。各アカウントの推定残の合計。平均使用率からの再校正・tok/1%の合算は行わない。保証された残量ではない。`
    : `推定残 ${tokens(estimate.estimatedRemainingTokens!)} tok / ${rateFormat.format(estimate.tokensPerPercent!)} tok/1% / 使用率差 ${rateFormat.format(estimate.sampledPercent)}% / 実測 ${tokens(estimate.sampledTokens)} tok。入力・出力・キャッシュ込み。保証された残量ではない。古い値・リセット後・計測不足は推定を保留する。`;
  const label = estimate.title.replace("5時間", "5h").replace("週間", "週").replace("利用クレジット", "クレジット");
  return (
    <span className="inline-flex min-w-0 shrink-0 items-baseline gap-1 whitespace-nowrap text-[10px] text-muted" title={title}>
      {showTitle && <span className="max-w-16 truncate">{label}</span>}
      <span>{showTitle ? "≈" : "残≈"}{compactTokens(estimate.estimatedRemainingTokens!)}{!showTitle && " tok"}</span>
    </span>
  );
}

export function TokenUsageDetails({ usage, now = Date.now(), combined, hiddenWindowIds = [] }: {
  usage: ProviderTokenUsage;
  now?: number;
  combined?: Combined;
  hiddenWindowIds?: readonly string[];
}) {
  const windows = usage.windows.map((window) => ({ window, ...estimateState(window, now, combined) }));
  const unavailable = windows.filter((entry) => !entry.available);
  const waiting = unavailable.some((entry) => entry.status === "calibrating");
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] text-muted">
      <span
        className="whitespace-nowrap"
        title={`${combined ? `対象 ${combined.measuredAccounts}/${combined.totalAccounts}行の実測合計 / ` : ""}実測 ${tokens(usage.totalTokens)} tok / 計測開始: ${usage.startedAt ?? "未計測"} / ${usage.responses}完了応答。入力 ${tokens(usage.input)} / 出力 ${tokens(usage.output)} / キャッシュ読取 ${tokens(usage.cacheRead)} / 書込 ${tokens(usage.cacheWrite)} tok。LeafCodePiの完了応答のみ。外部CLI・補助呼出・中断応答は含まない。`}
      >
        {combined ? "合計" : "実測"}{combined && combined.measuredAccounts < combined.totalAccounts ? "（一部）" : ""} <span>{compactTokens(usage.totalTokens)} tok</span>
      </span>
      {unavailable.length > 0 && (
        <span className="whitespace-nowrap text-faint"
          title={unavailable.map(({ window, status }) => `${window.title}: ${unavailableLabel[status]}`).join("\n")}
        >
          · {waiting ? "推定待ち" : "推定なし"}
        </span>
      )}
      {windows.filter((entry) => entry.available && !hiddenWindowIds.includes(entry.window.id)).map(({ window }) => (
        <TokenEstimateInline key={window.id} estimate={window} now={now} combined={combined} showTitle />
      ))}
    </div>
  );
}

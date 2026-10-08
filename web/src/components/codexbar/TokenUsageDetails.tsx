import type { ProviderTokenUsage } from "@/lib/codexbar/token-usage-types";

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const rateFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
function tokens(value: number): string {
  return numberFormat.format(Math.round(value));
}
function compactTokens(value: number, fractional = false): string {
  if (fractional && value < 1) return rateFormat.format(value);
  return compactFormat.format(fractional ? value : Math.round(value));
}

const unavailableLabel = {
  calibrating: "計測中／使用率差1%以上が必要",
  ready: "未校正",
  stale: "古い取得値",
  expired: "リセット期限経過",
  unsupported: "この利用枠は推定対象外",
  invalid: "使用率・日時を取得できない",
};

export function TokenUsageDetails({ usage, now = Date.now(), combined }: {
  usage: ProviderTokenUsage;
  now?: number;
  combined?: { measuredAccounts: number; totalAccounts: number };
}) {
  const windows = usage.windows.map((window) => {
    const stale = !!window.validUntil && Date.parse(window.validUntil) <= now;
    const available = !stale && (window.status === undefined || window.status === "ready") &&
      (combined !== undefined || window.tokensPerPercent !== null) && window.estimatedRemainingTokens !== null;
    const status = stale ? "stale" : window.status ?? "calibrating";
    return { window, available, status };
  });
  const unavailable = windows.filter((entry) => !entry.available);
  const waiting = unavailable.some((entry) => entry.status === "calibrating");

  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-1.5 text-xs text-muted">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
        <span
          className="whitespace-nowrap"
          title={`${combined ? `対象 ${combined.measuredAccounts}/${combined.totalAccounts}行の実測合計 / ` : ""}実測 ${tokens(usage.totalTokens)} tok / 計測開始: ${usage.startedAt ?? "未計測"} / ${usage.responses}完了応答。入力 ${tokens(usage.input)} / 出力 ${tokens(usage.output)} / キャッシュ読取 ${tokens(usage.cacheRead)} / 書込 ${tokens(usage.cacheWrite)} tok。LeafCodePiの完了応答のみ。外部CLI・補助呼出・中断応答は含まない。`}
        >
          {combined ? "実測合計" : "実測"}{combined && combined.measuredAccounts < combined.totalAccounts ? "（一部）" : ""} <span className="text-text">{compactTokens(usage.totalTokens)} tok</span>
        </span>
        {unavailable.length > 0 && (
          <span
            className="whitespace-nowrap text-faint"
            title={unavailable.map(({ window, status }) => `${window.title}: ${unavailableLabel[status]}`).join("\n")}
          >
            · {waiting ? "推定待ち" : "推定なし"}
          </span>
        )}
      </div>
      {windows.filter((entry) => entry.available).map(({ window }) => (
        <div
          key={window.id}
          className="flex min-w-0 flex-wrap gap-x-1"
          title={combined
            ? `推定残合計 ${tokens(window.estimatedRemainingTokens!)} tok。各アカウントの推定残の合計。平均使用率からの再校正・tok/1%の合算は行わない。保証された残量ではない。`
            : `推定残 ${tokens(window.estimatedRemainingTokens!)} tok / ${rateFormat.format(window.tokensPerPercent!)} tok/1% / 使用率差 ${rateFormat.format(window.sampledPercent)}% / 実測 ${tokens(window.sampledTokens)} tok。入力・出力・キャッシュ込み。モデル構成・外部消費・使用率の反映遅延で変動する実績推定であり、保証された残量ではない。古い値・リセット後・計測不足は推定を保留する。`}
        >
          <span>{window.title}: <span>推定残 {compactTokens(window.estimatedRemainingTokens!)} tok</span></span>
          {!combined && <span className="whitespace-nowrap">· {compactTokens(window.tokensPerPercent!, true)} tok/1%</span>}
        </div>
      ))}
    </div>
  );
}

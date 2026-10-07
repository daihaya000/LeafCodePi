import type { ProviderTokenUsage } from "@/lib/codexbar/token-usage-types";

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const rateFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
function tokens(value: number): string {
  return numberFormat.format(Math.round(value));
}

const unavailableLabel = {
  calibrating: "計測中／使用率差1%以上が必要",
  ready: "未校正",
  stale: "古い取得値",
  expired: "リセット期限経過",
  unsupported: "この利用枠は推定対象外",
  invalid: "使用率・日時を取得できない",
};

export function TokenUsageDetails({ usage, now = Date.now() }: { usage: ProviderTokenUsage; now?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-1.5 text-xs text-muted">
      <div
        title={`計測開始: ${usage.startedAt ?? "未計測"} / ${usage.responses}完了応答。入力 ${tokens(usage.input)} / 出力 ${tokens(usage.output)} / キャッシュ読取 ${tokens(usage.cacheRead)} / 書込 ${tokens(usage.cacheWrite)} tok。LeafCodePiの完了応答のみ。外部CLI・補助呼出・中断応答は含まない。`}
      >
        実測 <span className="text-text">{tokens(usage.totalTokens)} tok</span>
      </div>
      {usage.windows.map((window) => {
        const stale = !!window.validUntil && Date.parse(window.validUntil) <= now;
        const status = stale ? "stale" : window.status ?? "calibrating";
        const unavailable = stale || (window.status !== undefined && window.status !== "ready") ||
          window.tokensPerPercent === null || window.estimatedRemainingTokens === null;
        return (
          <div
            key={window.id}
            className="flex min-w-0 flex-wrap gap-x-1"
            title={`使用率差 ${rateFormat.format(window.sampledPercent)}% / 実測 ${tokens(window.sampledTokens)} tok。入力・出力・キャッシュ込み。モデル構成・外部消費・使用率の反映遅延で変動する実績推定であり、保証された残量ではない。古い値・リセット後・計測不足は推定を保留する。`}
          >
            <span>{window.title}:</span>
            {unavailable ? (
              <span className="text-faint">推定 —（{unavailableLabel[status]}）</span>
            ) : (
              <>
                <span>推定残 {tokens(window.estimatedRemainingTokens!)} tok</span>
                <span>· {rateFormat.format(window.tokensPerPercent!)} tok/1%</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

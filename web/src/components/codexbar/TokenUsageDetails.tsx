import type { ProviderTokenUsage } from "@/lib/codexbar/token-usage-types";

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
function tokens(value: number): string {
  return numberFormat.format(Math.round(value));
}

export function TokenUsageDetails({ usage }: { usage: ProviderTokenUsage }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-1.5 text-xs text-muted">
      <div
        title={`計測開始: ${usage.startedAt ?? "未計測"} / ${usage.responses}完了応答。入力 ${tokens(usage.input)} / 出力 ${tokens(usage.output)} / キャッシュ読取 ${tokens(usage.cacheRead)} / 書込 ${tokens(usage.cacheWrite)} tok。LeafCodePiの完了応答のみ。外部CLI・補助呼出・中断応答は含まない。`}
      >
        実測 <span className="text-text">{tokens(usage.totalTokens)} tok</span>
      </div>
      {usage.windows.map((window) => (
        <div
          key={window.id}
          className="flex min-w-0 flex-wrap gap-x-1"
          title={`使用率差 ${numberFormat.format(window.sampledPercent)}% / 実測 ${tokens(window.sampledTokens)} tok。入力・出力・キャッシュ込み。モデル構成・外部消費・使用率の反映遅延で変動する実績推定であり、保証された残量ではない。古い値・リセット後・計測不足は推定を保留する。`}
        >
          <span>{window.title}:</span>
          {window.tokensPerPercent === null || window.estimatedRemainingTokens === null ? (
            <span className="text-faint">推定 —（計測中／使用率差1%以上が必要）</span>
          ) : (
            <>
              <span>推定残 {tokens(window.estimatedRemainingTokens)} tok</span>
              <span>· {tokens(window.tokensPerPercent)} tok/1%</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

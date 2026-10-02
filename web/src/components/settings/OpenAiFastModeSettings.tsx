"use client";

import { Switch } from "@/components/ui";
import { useOpenAiFastMode } from "@/lib/use-openai-fast-mode";

export function OpenAiFastModeSettings() {
  const { enabled, error, update } = useOpenAiFastMode();

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">OpenAI Fastモード</h3>
      <p className="mt-1 text-xs text-muted">
        OpenAI・OpenAI Codexのモデルを優先処理（service_tier=priority）で実行し、応答を高速化します。
        利用料金は通常の約2倍（gpt-5.5は約2.5倍）になります。実行中のセッションにも次のリクエストから反映されます。
        Composerのモデル選択欄からも切り替えられます。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled}
          onChange={() => void update(!enabled)}
          label="OpenAI Fastモード"
        />
        <span className="text-sm text-text" aria-live="polite">
          {enabled ? "ON" : "OFF"}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

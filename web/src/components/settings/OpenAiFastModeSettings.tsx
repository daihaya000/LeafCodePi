"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  isOpenAiFastModeEnabled,
  OPENAI_FAST_MODE_SETTING_KEY,
} from "@/lib/openai-fast-mode";

export function OpenAiFastModeSettings() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getJson<{ value: string | null }>(`/api/settings/${OPENAI_FAST_MODE_SETTING_KEY}`)
      .then((result) => {
        if (active) setEnabled(isOpenAiFastModeEnabled(result.value));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Fastモードの読み込みに失敗しました");
      });
    return () => {
      active = false;
    };
  }, []);

  async function commit(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    try {
      await sendJson(`/api/settings/${OPENAI_FAST_MODE_SETTING_KEY}`, { value: next ? "1" : "" }, "PUT");
      setError(null);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "Fastモードの保存に失敗しました");
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">OpenAI Fastモード</h3>
      <p className="mt-1 text-xs text-muted">
        OpenAI・OpenAI Codexのモデルを優先処理（service_tier=priority）で実行し、応答を高速化します。
        利用料金は通常の約2倍（gpt-5.5は約2.5倍）になります。実行中のセッションにも次のリクエストから反映されます。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled}
          onChange={() => void commit(!enabled)}
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

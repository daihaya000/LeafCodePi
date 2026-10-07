"use client";

import { useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_MODEL_THROUGHPUT_WINDOW,
  MODEL_THROUGHPUT_WINDOW_OPTIONS,
  MODEL_THROUGHPUT_WINDOW_SETTING_KEY,
  parseModelThroughputWindow,
} from "@/lib/model-throughput-settings";

const SETTINGS_PATH = `/api/settings/${MODEL_THROUGHPUT_WINDOW_SETTING_KEY}`;

/** モデル選択欄の速度実績に使う直近応答数（サーバ保存）。 */
export function ModelThroughputSettings() {
  const [size, setSize] = useState(DEFAULT_MODEL_THROUGHPUT_WINDOW);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<{ value: string | null }>(SETTINGS_PATH)
      .then(({ value }) => {
        if (!active) return;
        setSize(parseModelThroughputWindow(value));
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "設定の読み込みに失敗しました");
      });
    return () => { active = false; };
  }, []);

  async function changeSize(raw: string) {
    const next = Number(raw);
    if (!MODEL_THROUGHPUT_WINDOW_OPTIONS.some((option) => option === next)) return;
    const previous = size;
    setSize(next);
    setSaving(true);
    setError(null);
    try {
      await sendJson(SETTINGS_PATH, { value: String(next) }, "PUT");
    } catch (cause) {
      setSize(previous);
      setError(cause instanceof Error ? cause.message : "設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  // 保存済みの値が選択肢にない場合も、その値を表示して失わないようにする。
  const options = MODEL_THROUGHPUT_WINDOW_OPTIONS.some((option) => option === size)
    ? [...MODEL_THROUGHPUT_WINDOW_OPTIONS]
    : [...MODEL_THROUGHPUT_WINDOW_OPTIONS, size].sort((a, b) => a - b);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">モデル速度の計測件数</h3>
      <p className="mt-1 text-xs text-muted">
        モデル×プロバイダーごとに、直近N件の生成トークン数の合計÷生成時間の合計で平均 tok/s を計算します。
        少ないほど変化に追従し、多いほど安定します。16トークン未満の応答と初動の待ち時間は除外します。
        件数不足時は蓄積分を使用。最大1000件を保持し、次回のモデル一覧取得から設定が反映されます。
        旧累積データは引き継がず、新しい応答から再計測します。
      </p>
      <label className="mt-3 flex flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
        <span className="shrink-0 text-sm text-muted">直近の応答数</span>
        <select
          value={size}
          aria-label="モデル速度の直近計測件数"
          disabled={!loaded || saving}
          onChange={(event) => void changeSize(event.target.value)}
          className="h-9 w-full max-w-[14rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-50"
        >
          {options.map((value) => (
            <option key={value} value={value}>
              {value}件{value === DEFAULT_MODEL_THROUGHPUT_WINDOW ? "（既定）" : ""}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

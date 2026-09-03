"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_SCROLL_BUTTON_OPACITY,
  MAX_SCROLL_BUTTON_OPACITY,
  MIN_SCROLL_BUTTON_OPACITY,
  readScrollButtonOpacity,
  subscribeScrollButtonOpacity,
  writeScrollButtonOpacity,
} from "@/lib/scroll-button-opacity";

/** ナビゲーター（メッセージ移動ボタン）の不透明度を変えるスライダー。 */
export function NavigatorSettings() {
  // SSRとの一致を保つため初期値は定数固定とし、mount後にlocalStorageの保存値へ切り替える。
  const [opacity, setOpacity] = useState(DEFAULT_SCROLL_BUTTON_OPACITY);
  useEffect(() => {
    setOpacity(readScrollButtonOpacity());
    return subscribeScrollButtonOpacity(() => setOpacity(readScrollButtonOpacity()));
  }, []);

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-muted">UI</h2>
      <div className="rounded-xl border border-border bg-surface px-4 py-3">
        <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">メッセージ移動ボタンの不透明度</span>
          <input
            type="range"
            min={MIN_SCROLL_BUTTON_OPACITY}
            max={MAX_SCROLL_BUTTON_OPACITY}
            step={0.05}
            value={opacity}
            aria-label="メッセージ移動ボタンの不透明度"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) writeScrollButtonOpacity(value);
            }}
            className="w-full max-w-[14rem] accent-accent"
          />
          <span className="w-12 font-mono text-xs text-muted">{Math.round(opacity * 100)}%</span>
        </label>
        <p className="mt-2 text-[11px] text-muted">
          タスク画面右下のメッセージ移動ボタンの不透明度です（
          {Math.round(MIN_SCROLL_BUTTON_OPACITY * 100)}〜{Math.round(MAX_SCROLL_BUTTON_OPACITY * 100)}
          %）。値を下げると背後のメッセージが見えやすくなります。ホバー時は一時的に不透明になります。
        </p>
      </div>
      {/* 初期値の明示（本家と同じ 60%）。 */}
      <p className="mt-1 text-[11px] text-muted">既定値 {Math.round(DEFAULT_SCROLL_BUTTON_OPACITY * 100)}%</p>
    </section>
  );
}

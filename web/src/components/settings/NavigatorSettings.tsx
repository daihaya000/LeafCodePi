"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui";
import {
  DEFAULT_PREFER_NEW_PANE,
  readPreferNewPane,
  subscribePreferNewPane,
  writePreferNewPane,
} from "@/lib/task-panes";
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
  const [preferNewPane, setPreferNewPane] = useState(DEFAULT_PREFER_NEW_PANE);
  useEffect(() => {
    setOpacity(readScrollButtonOpacity());
    setPreferNewPane(readPreferNewPane());
    const unsubscribeOpacity = subscribeScrollButtonOpacity(() => setOpacity(readScrollButtonOpacity()));
    const unsubscribePane = subscribePreferNewPane(() => setPreferNewPane(readPreferNewPane()));
    return () => {
      unsubscribeOpacity();
      unsubscribePane();
    };
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">ナビゲーション</h3>
      <p className="mt-1 text-xs text-muted">
        タスク画面のメッセージ移動ボタンの見え方を設定します。
      </p>
      <label className="mt-4 flex flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
        <span className="shrink-0 text-sm text-muted">不透明度</span>
        <span className="flex min-w-0 flex-1 items-center gap-3">
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
            className="min-w-0 flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
          <output className="w-12 shrink-0 text-right font-mono text-sm text-text">
            {Math.round(opacity * 100)}%
          </output>
        </span>
      </label>
      <p className="mt-2.5 text-[11px] text-muted">
        値を下げると背後のメッセージが見えやすくなります。ホバー時は一時的に不透明になります。
        既定値は{Math.round(DEFAULT_SCROLL_BUTTON_OPACITY * 100)}%です。
      </p>
      <div className="mt-4 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-text">新規セッション・Botの開き方</p>
            <p className="mt-1 text-xs text-muted">
              新規セッションやBot画面を開くとき、新しいペインと既存タブのどちらを優先するか選びます。
            </p>
          </div>
          <Switch
            checked={preferNewPane}
            onChange={() => writePreferNewPane(!preferNewPane)}
            label="新規セッション・Botを新しいペインで開く"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted" aria-live="polite">
          現在: {preferNewPane ? "ペイン分割を優先" : "従来のタブ動作"}
        </p>
      </div>
    </div>
  );
}

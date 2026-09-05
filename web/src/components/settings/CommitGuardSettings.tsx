"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type CommitGuardDto = {
  enabled: boolean;
};

export function CommitGuardSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void getJson<CommitGuardDto>("/api/settings/commit-guard")
      .then((result) => {
        setEnabled(result.enabled);
        setLoaded(true);
        setError(null);
      })
      .catch((err) => {
        setLoaded(true);
        setEnabled(null);
        setError(err instanceof Error ? err.message : "コミットガード設定の取得に失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = async (next: boolean) => {
    if (busy || enabled === null || next === enabled) return;
    setBusy(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    try {
      const result = await sendJson<CommitGuardDto>(
        "/api/settings/commit-guard",
        { enabled: next },
        "PATCH",
      );
      setEnabled(result.enabled);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "コミットガード設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const ready = loaded && enabled !== null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">コミットガード</h3>
      <p className="mt-1 text-xs text-muted">
        タスクが未コミットの変更を残したとき、差分確認とコミットを促すフォローアップを出します。拡張は常時読み込みのまま、機能だけ切り替えます。既定は有効です。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled === true}
          onChange={() => void toggle(!(enabled === true))}
          label="コミットガードを有効にする"
          busy={busy || !loaded}
          disabled={!ready}
        />
        <span className="text-sm text-text" aria-live="polite">
          {!loaded ? "読込中" : enabled === null ? "不明" : enabled ? "有効" : "無効"}
        </span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
          再読込
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

const EXTENSION_ID = "leafcode-commit-guard";

type ExtensionDto = {
  id: string;
  name: string;
  enabled: boolean;
};

type ExtensionsResponse = {
  extensions: ExtensionDto[];
};

function enabledFromList(extensions: ExtensionDto[]): boolean | null {
  const entry = extensions.find((extension) => extension.id === EXTENSION_ID || extension.name === EXTENSION_ID);
  return entry ? entry.enabled : null;
}

export function CommitGuardSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void getJson<ExtensionsResponse>("/api/extensions")
      .then((result) => {
        const next = enabledFromList(result.extensions);
        if (next === null) {
          setAvailable(false);
          setEnabled(false);
        } else {
          setAvailable(true);
          setEnabled(next);
        }
        setLoaded(true);
        setError(null);
      })
      .catch((err) => {
        setLoaded(true);
        setError(err instanceof Error ? err.message : "コミットガード設定の取得に失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = async (next: boolean) => {
    if (!available || busy || enabled === null || next === enabled) return;
    setBusy(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    try {
      const result = await sendJson<ExtensionsResponse & { enabled?: boolean }>(
        `/api/extensions/${encodeURIComponent(EXTENSION_ID)}`,
        { enabled: next },
        "PATCH",
      );
      const fromList = enabledFromList(result.extensions);
      setEnabled(fromList ?? result.enabled ?? next);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "コミットガード設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = !loaded
    ? "読込中"
    : !available
      ? "拡張なし"
      : enabled === null
        ? "不明"
        : enabled
          ? "有効"
          : "無効";

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">コミットガード</h3>
      <p className="mt-1 text-xs text-muted">
        タスクが未コミットの変更を残したとき、差分確認とコミットを促すフォローアップを出します。既定は有効です。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled === true}
          onChange={() => void toggle(!(enabled === true))}
          label="コミットガードを有効にする"
          busy={busy || !loaded}
          disabled={!available || !loaded || enabled === null}
        />
        <span className="text-sm text-text" aria-live="polite">
          {statusLabel}
        </span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
          再読込
        </Button>
      </div>
      {!available && loaded && (
        <p className="mt-2 text-xs text-muted">
          <span className="font-mono">{EXTENSION_ID}</span> が見つからないため切り替えできません。
        </p>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

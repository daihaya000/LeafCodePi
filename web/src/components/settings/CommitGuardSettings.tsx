"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { getJson } from "@/lib/client";

const EXTENSION_ID = "leafcode-commit-guard";

type ExtensionDto = {
  id: string;
  name: string;
  enabled: boolean;
  required?: boolean;
};

type ExtensionsResponse = {
  extensions: ExtensionDto[];
};

function findEntry(extensions: ExtensionDto[]): ExtensionDto | null {
  return extensions.find((extension) => extension.id === EXTENSION_ID || extension.name === EXTENSION_ID) ?? null;
}

export function CommitGuardSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(true);
  const [required, setRequired] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void getJson<ExtensionsResponse>("/api/extensions")
      .then((result) => {
        const entry = findEntry(result.extensions);
        if (!entry) {
          setAvailable(false);
          setEnabled(false);
          setRequired(false);
        } else {
          setAvailable(true);
          setEnabled(entry.enabled);
          setRequired(entry.required !== false);
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

  const statusLabel = !loaded
    ? "読込中"
    : !available
      ? "拡張なし"
      : enabled === null
        ? "不明"
        : enabled
          ? "有効"
          : "無効";

  const locked = required && enabled === true;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">コミットガード</h3>
      <p className="mt-1 text-xs text-muted">
        タスクが未コミットの変更を残したとき、差分確認とコミットを促すフォローアップを出します。既定は有効です。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled === true}
          onChange={() => {}}
          label="コミットガードを有効にする"
          busy={!loaded}
          disabled={!available || !loaded || enabled === null || locked}
          title={locked ? "WebUI が依存する拡張機能のため無効化できません" : undefined}
        />
        <span className="text-sm text-text" aria-live="polite">
          {statusLabel}
        </span>
        <Button variant="ghost" size="sm" onClick={() => reload()}>
          再読込
        </Button>
      </div>
      {locked && (
        <p className="mt-2 text-xs text-muted">WebUI が依存するため無効化できません</p>
      )}
      {!available && loaded && (
        <p className="mt-2 text-xs text-muted">
          <span className="font-mono">{EXTENSION_ID}</span> が見つからないため切り替えできません。
        </p>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

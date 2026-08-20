"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { formatTokens } from "@/lib/context-usage";
import type { CompactionSettingsDto } from "@/lib/types";

export function CompactionSettings() {
  const [settings, setSettings] = useState<CompactionSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void getJson<{ settings: CompactionSettingsDto }>("/api/compaction-settings")
      .then((result) => {
        setSettings(result.settings);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "圧縮設定の読み込みに失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ settings: CompactionSettingsDto }>(
        "/api/compaction-settings",
        { enabled },
        "PATCH",
      );
      setSettings(result.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">コンテキスト圧縮</h2>
        {settings && (
          <Badge tone={settings.enabled ? "success" : "neutral"}>
            {settings.enabled ? "自動オン" : "自動オフ"}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted">
        長い会話の履歴を要約してコンテキストを空けます。手動圧縮はタスク画面のヘッダーから実行できます。
      </p>
      <label className="mt-3 flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent"
          checked={settings?.enabled ?? true}
          disabled={!settings || busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>閾値到達・オーバーフロー時に自動圧縮する</span>
      </label>
      {settings && (
        <p className="mt-2 text-[11px] text-faint">
          予約トークン {formatTokens(settings.reserveTokens)} / 直近保持{" "}
          {formatTokens(settings.keepRecentTokens)}（Pi `settings.json`）
        </p>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {busy && (
        <div className="mt-2">
          <Button size="sm" busy disabled>
            保存中
          </Button>
        </div>
      )}
    </div>
  );
}

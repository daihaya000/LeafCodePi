"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

export function BrowserSettings() {
  const [autoOpen, setAutoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void getJson<{ autoOpenBrowser?: boolean }>("/api/host/browser-config")
      .then((config) => {
        setAutoOpen(config.autoOpenBrowser === true);
        setLoaded(true);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "ブラウザ設定の取得に失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ ok?: boolean; autoOpenBrowser?: boolean; error?: string }>(
        "/api/host/browser-config",
        { autoOpenBrowser: enabled },
        "POST",
      );
      if (!result.ok) throw new Error(result.error || "保存に失敗しました");
      setAutoOpen(result.autoOpenBrowser === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ブラウザ起動設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">ブラウザ</h2>
      <p className="mt-1 text-xs text-muted">
        EXE 起動時にブラウザを自動で開きます。デフォルトはオフです。設定は次回の EXE 起動から反映されます。
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={autoOpen}
          aria-label="起動時にブラウザを自動で開く"
          disabled={busy || !loaded}
          onClick={() => void toggle(!autoOpen)}
          className={cx(
            "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
            autoOpen ? "bg-primary" : "bg-surface-3",
          )}
        >
          <span
            className={cx(
              "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform",
              autoOpen && "translate-x-5",
            )}
          />
        </button>
        <span className="text-sm text-text">{autoOpen ? "自動で開く" : "開かない"}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
          再読込
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

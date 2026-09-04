"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type SystemSafetyDto = {
  systemSafety: boolean;
};

export function SystemSafetySettings() {
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void getJson<SystemSafetyDto>("/api/settings/system-safety")
      .then((config) => {
        setEnabled(config.systemSafety !== false);
        setLoaded(true);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "システム安全ガード設定の取得に失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    try {
      const result = await sendJson<SystemSafetyDto>(
        "/api/settings/system-safety",
        { systemSafety: next },
        "PATCH",
      );
      setEnabled(result.systemSafety !== false);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "システム安全ガード設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">システム安全ガード</h2>
      <p className="mt-1 text-xs text-muted">
        OS・サービス・ディスクなどへの危険な変更を、調査・計画・明示承認で止めます。無効にしても
        `.env` / `.ssh` などの保護パスと LeafCodePi 自身の停止禁止は続きます。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled}
          onChange={() => void toggle(!enabled)}
          label="システム安全ガードを有効化"
          busy={busy || !loaded}
        />
        <span className="text-sm text-text">{enabled ? "有効" : "無効"}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
          再読込
        </Button>
      </div>
      {!enabled && (
        <p className="mt-2 text-xs text-warning">
          無効中は OS 変更系コマンドの調査・承認フローが動きません。必要なときだけ切ってください。
        </p>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

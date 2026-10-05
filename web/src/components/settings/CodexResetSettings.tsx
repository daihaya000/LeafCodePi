"use client";

import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type ResetSettings = { codexResetAutoConsume?: boolean; version: string };
const ENDPOINT = "/api/codexbar/providers";

export function CodexResetSettings() {
  const [settings, setSettings] = useState<ResetSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const enabled = settings?.codexResetAutoConsume !== false;

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void getJson<ResetSettings>(ENDPOINT).then((data) => {
      if (active) setSettings(data);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "設定の取得に失敗しました");
    });
    return () => { active = false; mounted.current = false; };
  }, []);

  async function toggle() {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await sendJson<ResetSettings>(ENDPOINT, {
        codexResetAutoConsume: !enabled,
        version: settings.version,
      }, "PUT");
      if (!mounted.current) return;
      setSettings(updated);
      setError(null);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : "設定の保存に失敗しました");
      // Reload the actual value/version after a concurrent settings change; no optimistic state.
      try {
        const current = await getJson<ResetSettings>(ENDPOINT);
        if (mounted.current) setSettings(current);
      } catch { /* Keep last confirmed value. */ }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">Codex リセット権の自動使用</h3>
      <p className="mt-1 text-xs text-muted">
        有効期限が近いリセット権を、期限が近い順に自動使用します（既定ON、通常は期限まで24時間以内）。
        画面を閉じても確認を続けます。保存後の次回確認から反映されます。
        LeafCodePiの停止・PCのスリープ中は動作しません。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled}
          onChange={() => void toggle()}
          disabled={!settings}
          busy={saving}
          label="Codex リセット権の自動使用"
        />
        <span className="text-sm text-text" aria-live="polite">
          {!settings ? error ? "取得失敗" : "読込中" : saving ? "保存中" : enabled ? "ON" : "OFF"}
        </span>
      </div>
      {settings && !enabled && (
        <p className="mt-2 text-xs text-muted">自動使用が無効のため、未使用のリセット権が失効する可能性があります。</p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

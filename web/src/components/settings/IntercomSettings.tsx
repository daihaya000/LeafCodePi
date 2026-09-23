"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_INTERCOM_TRIGGER_POLICY,
  INTERCOM_TRIGGER_POLICIES,
  isIntercomTriggerPolicy,
  type IntercomConfigDto,
  type IntercomTriggerPolicy,
} from "@/lib/intercom-trigger";

const POLICY_LABELS: Record<IntercomTriggerPolicy, string> = {
  replies: "進行中の問い合わせへの返信のみ",
  always: "すべての受信メッセージ",
  never: "自動起動しない",
};

export function IntercomSettings() {
  const [policy, setPolicy] = useState<IntercomTriggerPolicy>(DEFAULT_INTERCOM_TRIGGER_POLICY);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoaded(false);
    void getJson<IntercomConfigDto>("/api/settings/intercom")
      .then((result) => {
        if (!isIntercomTriggerPolicy(result.inboundTrigger)) {
          throw new Error("Intercom設定の値が不正です");
        }
        setPolicy(result.inboundTrigger);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Intercom設定の取得に失敗しました");
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async (next: IntercomTriggerPolicy) => {
    if (busy || next === policy) return;
    const previous = policy;
    setPolicy(next);
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const result = await sendJson<IntercomConfigDto>(
        "/api/settings/intercom",
        { inboundTrigger: next },
        "PATCH",
      );
      if (!isIntercomTriggerPolicy(result.inboundTrigger)) {
        throw new Error("Intercom設定の保存結果が不正です");
      }
      setPolicy(result.inboundTrigger);
      setSaved(true);
    } catch (err) {
      setPolicy(previous);
      setError(err instanceof Error ? err.message : "Intercom設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Intercom受信</h3>
          <p className="mt-1 text-xs text-muted">
            アイドル中のセッションが受信メッセージで新しいターンを開始する範囲を設定します。
            実行中のセッションへのsteerはこの設定に関わらず維持されます。
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={reload}>
          再読込
        </Button>
      </div>
      <label className="mt-4 flex flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
        <span className="shrink-0 text-sm text-muted">自動起動範囲</span>
        <select
          value={policy}
          disabled={!loaded || busy}
          aria-label="Intercom受信の自動起動範囲"
          onChange={(event) => {
            if (isIntercomTriggerPolicy(event.target.value)) void save(event.target.value);
          }}
          className="h-9 w-full max-w-md rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-60"
        >
          {INTERCOM_TRIGGER_POLICIES.map((value) => (
            <option key={value} value={value}>{POLICY_LABELS[value]}</option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-[11px] text-muted">
        「返信のみ」では、保留中の問い合わせへの返信だけがアイドル中のセッションを自動起動します。変更は次回のセッション開始時から反映されます。
      </p>
      {saved && <p className="mt-2 text-xs text-muted" aria-live="polite">保存しました</p>}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

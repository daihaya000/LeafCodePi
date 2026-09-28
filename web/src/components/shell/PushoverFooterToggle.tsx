"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type NotificationState = { enabled: boolean };

/** Shared server setting: switching off suppresses completion and test delivery. */
export function PushoverFooterToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<NotificationState>("/api/pushover")
      .then((state) => { if (active) setEnabled(state.enabled); })
      .catch(() => { if (active) setError("通知設定を取得できません"); });
    return () => { active = false; };
  }, []);

  async function toggle() {
    if (enabled === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await sendJson<NotificationState>("/api/pushover", { enabled: !enabled }, "PUT");
      setEnabled(state.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "通知設定を保存できません");
    } finally {
      setBusy(false);
    }
  }

  const label = enabled === null ? "Pushover通知の状態を確認中" : enabled ? "Pushover通知をオフにする" : "Pushover通知をオンにする";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={enabled ?? false}
        title={error ?? label}
        disabled={enabled === null || busy}
        busy={busy}
        onClick={() => void toggle()}
      >
        {!busy && (error ? <CircleAlert className="h-4 w-4 text-danger" aria-hidden="true" />
          : enabled ? <Bell className="h-4 w-4 text-accent" aria-hidden="true" />
            : <BellOff className="h-4 w-4" aria-hidden="true" />)}
      </Button>
      {error && <span role="status" className="sr-only">{error}</span>}
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { setNotificationDeliveryEnabled, useNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";

type NotificationState = { enabled: boolean };

/** One footer switch for browser and Pushover notifications. */
export function PushoverFooterToggle() {
  const enabled = useNotificationDeliveryEnabled();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<NotificationState>("/api/notifications")
      .then((state) => {
        if (!active) return;
        setNotificationDeliveryEnabled(state.enabled);
        setLoaded(true);
      })
      .catch(() => { if (active) setError("通知設定を取得できません"); });
    return () => { active = false; };
  }, []);

  async function toggle() {
    if (!loaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await sendJson<NotificationState>("/api/notifications", { enabled: !enabled }, "PUT");
      setNotificationDeliveryEnabled(state.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "通知設定を保存できません");
    } finally {
      setBusy(false);
    }
  }

  const label = !loaded ? "通知の状態を確認中" : enabled ? "通知をオフにする（ブラウザ・Pushover）" : "通知をオンにする（ブラウザ・Pushover）";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={enabled}
        title={error ?? label}
        disabled={!loaded || busy}
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

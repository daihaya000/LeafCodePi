"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { setNotificationDeliveryEnabled, useNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";
import type { PushoverSettingsDto, PushoverSettingsPatch } from "@/lib/pushover-config";

const fieldClass = "min-h-11 min-w-0 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-50";

export function PushoverSettings() {
  const [snapshot, setSnapshot] = useState<PushoverSettingsDto | null>(null);
  const notificationsEnabled = useNotificationDeliveryEnabled();
  const [token, setToken] = useState("");
  const [user, setUser] = useState("");
  const [device, setDevice] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [clearUser, setClearUser] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((value: PushoverSettingsDto) => {
    setNotificationDeliveryEnabled(value.enabled);
    setSnapshot(value);
    setToken("");
    setUser("");
    setDevice(value.device);
    setClearToken(false);
    setClearUser(false);
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotice(null);
    void getJson<PushoverSettingsDto>("/api/pushover", undefined, { coalesce: false })
      .then(apply)
      .catch(() => setError("Pushover設定を取得できません。WebUIアクセスゲートを確認してください。"))
      .finally(() => setLoading(false));
  }, [apply]);

  useEffect(() => { reload(); }, [reload]);

  const dirty = snapshot !== null && (
    Boolean(token.trim() || user.trim() || clearToken || clearUser) || device.trim() !== snapshot.device
  );
  const busy = loading || saving || testing;
  const configured = Boolean(snapshot?.hasToken && snapshot.hasUser);

  async function save() {
    if (!snapshot || !dirty || busy) return;
    const patch: PushoverSettingsPatch = {};
    if (clearToken) patch.token = null;
    else if (token.trim()) patch.token = token.trim();
    if (clearUser) patch.user = null;
    else if (user.trim()) patch.user = user.trim();
    if (device.trim() !== snapshot.device) patch.device = device.trim() || null;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendJson<PushoverSettingsDto>("/api/pushover", patch, "PUT");
      apply(result);
      setNotice("保存しました。次のタスク完了から反映されます。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pushover設定を保存できません");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (busy || dirty || !configured || !notificationsEnabled) return;
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      await sendJson<{ sent: true }>("/api/pushover", undefined, "POST", { timeoutMs: 10_000 });
      setNotice("テスト通知を送信しました。iPhoneを確認してください。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "テスト通知を送信できません");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">iPhoneへの通知（Pushover）</h3>
          <p className="mt-1 text-xs text-muted">Code・Botのタスク完了をiPhoneに通知します。会話ではなくタスク名だけを送信します。ブラウザ通知と共通のON/OFFはサイドバー下部で切り替えられます。</p>
          <p className="mt-1 text-xs text-muted">
            <a href="https://pushover.net/" target="_blank" rel="noopener noreferrer" className="text-accent underline">User Key</a>
            と <a href="https://pushover.net/apps/build" target="_blank" rel="noopener noreferrer" className="text-accent underline">アプリ/APIトークン</a> を取得して入力してください。
          </p>
        </div>
        <Badge tone={configured && notificationsEnabled ? "success" : "neutral"}>{configured ? notificationsEnabled ? "設定済み" : "通知OFF" : "未設定"}</Badge>
      </div>

      <div className="mt-4 space-y-3">
        {([
          { key: "token" as const, label: "アプリ/APIトークン", value: token, setValue: setToken, exists: snapshot?.hasToken, clear: clearToken, setClear: setClearToken, managed: snapshot?.envManaged.token },
          { key: "user" as const, label: "User Key", value: user, setValue: setUser, exists: snapshot?.hasUser, clear: clearUser, setClear: setClearUser, managed: snapshot?.envManaged.user },
        ]).map((field) => (
          <div key={field.key}>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
              <label htmlFor={`pushover-${field.key}`} className="text-muted">{field.label}</label>
              <span className="text-xs text-muted">{field.managed ? "環境変数で管理" : field.clear ? "削除予定" : field.exists ? "設定済み" : "未設定"}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <input
                id={`pushover-${field.key}`}
                type="password"
                autoComplete="new-password"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={128}
                value={field.value}
                disabled={busy || Boolean(field.managed || field.clear)}
                onChange={(event) => { field.setValue(event.target.value); setNotice(null); }}
                placeholder={field.exists ? "変更しない場合は空欄" : "新しいキーを入力"}
                className={fieldClass}
              />
              {field.exists && !field.managed && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
                  field.setClear(!field.clear);
                  field.setValue("");
                  setNotice(null);
                }}>{field.clear ? "取消" : "削除"}</Button>
              )}
            </div>
          </div>
        ))}
        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">送信先デバイス（任意）</span>
          <input
            type="text"
            value={device}
            maxLength={100}
            disabled={busy || snapshot?.envManaged.device === true}
            onChange={(event) => { setDevice(event.target.value); setNotice(null); }}
            placeholder="空欄なら全デバイス"
            className={fieldClass}
          />
        </label>
        {snapshot?.envManaged.device && <p className="text-xs text-muted">デバイスは環境変数で管理されています。</p>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="primary" size="sm" busy={saving} disabled={busy || !dirty} onClick={() => void save()}>保存</Button>
        <Button type="button" variant="secondary" size="sm" busy={testing} disabled={busy || dirty || !configured || !notificationsEnabled} onClick={() => void test()}>テスト通知</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reload}>再読込</Button>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        キーは保存後に画面へ表示しません。タスク名はPushoverへ送られるため、機密情報を含めないでください。
      </p>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="mt-2 text-sm text-success" role="status">{notice}</p>}
    </div>
  );
}

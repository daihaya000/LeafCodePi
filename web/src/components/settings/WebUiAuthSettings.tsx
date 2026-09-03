"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

const TOKEN_MIN_LENGTH = 4;
const TOKEN_MAX_LENGTH = 512;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

type WebUiAuthSnapshot = {
  enabled: boolean;
  remote: boolean;
  authRequired: boolean;
  tokenConfigured: boolean;
  envManaged: boolean;
};

function status(snapshot: WebUiAuthSnapshot | null): { label: string; tone: "neutral" | "success" | "warning" } {
  if (!snapshot) return { label: "読み込み中", tone: "neutral" };
  if (!snapshot.remote) return { label: "ローカル", tone: "neutral" };
  if (!snapshot.enabled) return { label: "無効", tone: "warning" };
  if (snapshot.authRequired) return { label: "保護中", tone: "success" };
  return { label: "要確認", tone: "warning" };
}

export function WebUiAuthSettings() {
  const [snapshot, setSnapshot] = useState<WebUiAuthSnapshot | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<WebUiAuthSnapshot>("/api/host/webui-auth")
      .then((result) => {
        setSnapshot(result);
        setEnabled(result.enabled);
        setToken("");
        setError(null);
        setNotice(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "WebUI認証設定の読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const nextToken = token.trim();
  const dirty = snapshot !== null && (enabled !== snapshot.enabled || nextToken.length > 0);
  const disabled = loading || saving;
  const currentStatus = status(snapshot);

  async function save() {
    if (!dirty) return;
    if (
      nextToken &&
      (nextToken.length < TOKEN_MIN_LENGTH ||
        nextToken.length > TOKEN_MAX_LENGTH ||
        !TOKEN_PATTERN.test(nextToken))
    ) {
      setError(`トークンは${TOKEN_MIN_LENGTH}〜${TOKEN_MAX_LENGTH}文字のURL-safe文字列で入力してください`);
      return;
    }
    if (snapshot?.envManaged && nextToken) {
      setError("環境変数で管理されているトークンはここから変更できません");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendJson<WebUiAuthSnapshot>(
        "/api/host/webui-auth",
        { enabled, ...(nextToken ? { token: nextToken } : {}) },
        "POST",
      );
      setSnapshot(result);
      setEnabled(result.enabled);
      setToken("");
      setNotice("保存しました。WebUIを再起動して反映しています。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "WebUI認証設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">WebUI アクセス</h2>
          <p className="mt-1 text-xs text-muted">
            リモート接続時のアクセスゲートとトークンを設定します。トークン本文は表示・保存結果に返しません。
          </p>
        </div>
        <Badge tone={currentStatus.tone}>{currentStatus.label}</Badge>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={enabled}
            onChange={() => {
              setEnabled((value) => !value);
              setNotice(null);
            }}
            label="WebUIアクセスゲート"
            disabled={disabled}
          />
          <span className="text-sm font-medium">アクセスゲートを{enabled ? "有効" : "無効"}にする</span>
        </div>

        {snapshot?.remote && !enabled && (
          <p className="rounded-xl border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
            無効にすると、リモート接続でもトークンなしでWebUIへアクセスできます。
          </p>
        )}
        {snapshot && !snapshot.remote && (
          <p className="text-xs text-muted">現在はローカル接続のため、ゲート設定に関係なく認証は要求されません。</p>
        )}

        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">新しいアクセストークン</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={TOKEN_MIN_LENGTH}
            maxLength={TOKEN_MAX_LENGTH}
            value={token}
            disabled={disabled || snapshot?.envManaged === true}
            onChange={(event) => {
              setToken(event.target.value);
              setNotice(null);
            }}
            aria-describedby="webui-auth-help"
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm outline-none focus:border-border-strong disabled:opacity-50"
            placeholder={`${TOKEN_MIN_LENGTH}文字以上（変更しない場合は空欄）`}
          />
        </label>
        <p id="webui-auth-help" className="text-[11px] text-faint">
          {snapshot?.envManaged
            ? "LEAFCODE_PI_WEBUI_TOKEN が環境変数で指定されているため、トークン変更は環境変数側で行ってください。"
            : "変更後は現在のログイン cookie も新しいトークンへ更新されます。保存時にWebUIが再起動します。"}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="primary" size="sm" busy={saving} disabled={disabled || !dirty} onClick={() => void save()}>
          保存
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={reload}>
          再読込
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="mt-2 text-sm text-success" role="status">{notice}</p>}
    </div>
  );
}

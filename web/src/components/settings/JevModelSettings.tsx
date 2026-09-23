"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_JEV_MODEL_SETTINGS,
  jevModelEndpoint,
  type JevModelSettings as Settings,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";

const inputClass = "mt-1 h-11 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-50";

export function JevModelSettings() {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_JEV_MODEL_SETTINGS });
  const [saved, setSaved] = useState<JevModelSettingsDto | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let active = true;
    void getJson<JevModelSettingsDto>("/api/jev-model").then((dto) => {
      if (!active) return;
      setSettings(dto.settings);
      setSaved(dto);
    }).catch(() => {
      if (active) setError("Jevモデル設定を取得できません。設定画面を開き直してください。");
    });
    return () => { active = false; };
  }, []);

  const compatible = settings.provider === "compatible";
  const hasKey = compatible
    ? saved?.settings.compatibleBaseUrl === settings.compatibleBaseUrl && saved?.hasApiKey.compatible
    : saved?.hasApiKey.typesafe;

  function update(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setStatus("");
    if ("provider" in patch || "compatibleBaseUrl" in patch) {
      setApiKey("");
      setRemoveKey(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const dto = await sendJson<JevModelSettingsDto>("/api/jev-model", {
        settings,
        ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }, "PUT");
      setSettings(dto.settings);
      setSaved(dto);
      setApiKey("");
      setRemoveKey(false);
      setStatus("保存しました。次のJev判定から反映されます。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Jevモデル設定を保存できません");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">Jevモデル</h3>
      <p className="mt-1 text-xs text-muted">
        Autoモデル・エージェント選択、ラベル分類、Jev履歴圧縮、jev_judgeの共通接続先です。各機能の有効設定は変えず、Composerには表示しません。
      </p>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!saved || busy} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Jevプロバイダー
              <select value={settings.provider} onChange={(event) => update({ provider: event.target.value as Settings["provider"] })} className={inputClass}>
                <option value="typesafe">TypeSafe（Jev）</option>
                <option value="compatible">Jev互換API</option>
              </select>
            </label>
            <label className="text-xs text-muted">
              JevモデルID
              <input required maxLength={256} value={compatible ? settings.compatibleModel : settings.typesafeModel} onChange={(event) => update(compatible ? { compatibleModel: event.target.value } : { typesafeModel: event.target.value })} className={inputClass} />
            </label>
          </div>
          {compatible ? (
            <label className="block text-xs text-muted">
              APIベースURL（/systemoneを除く）
              <input required type="url" maxLength={2048} placeholder="http://localhost:8080/v1" value={settings.compatibleBaseUrl} onChange={(event) => update({ compatibleBaseUrl: event.target.value })} className={inputClass} />
            </label>
          ) : <p className="text-xs text-muted">接続先: {jevModelEndpoint(settings).baseUrl}/systemone</p>}
          <p className="text-xs text-muted">会話・ツール結果を送信するため、信頼できる接続先だけを指定してください。互換APIへの失敗時にTypeSafeへ転送することはありません。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Jev APIキー{compatible ? "（認証不要なら空欄）" : ""}
              <input type="password" autoComplete="new-password" maxLength={4096} value={apiKey} placeholder={hasKey ? "設定済み（空欄で維持）" : "未設定"} disabled={removeKey} onChange={(event) => { setApiKey(event.target.value); setStatus(""); }} className={inputClass} />
            </label>
            <label className="text-xs text-muted">
              タイムアウト（ミリ秒）
              <input required type="number" min={100} max={120000} step={100} value={settings.timeoutMs} onChange={(event) => update({ timeoutMs: Number(event.target.value) })} className={inputClass} />
            </label>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={removeKey} onChange={(event) => { setRemoveKey(event.target.checked); setApiKey(""); setStatus(""); }} />
            選択した接続先の保存済みAPIキーを削除
          </label>
          <p className="text-xs text-muted">キーはサーバーの認証ストレージに保存します。互換APIのキーは接続URLごとに分離します。TypeSafeは既存キー・TYPESAFE_API_KEYを利用します。</p>
          <Button type="submit" variant="secondary" size="sm">{busy ? "保存中…" : "Jevモデルを保存"}</Button>
        </fieldset>
      </form>
      {!saved && !error && <p role="status" className="mt-2 text-xs text-muted">読み込み中…</p>}
      {status && <p role="status" className="mt-2 text-xs text-muted">{status}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

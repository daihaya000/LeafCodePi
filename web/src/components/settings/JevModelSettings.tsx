"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { jevModelKey } from "@/lib/jev-model-catalog";
import {
  DEFAULT_JEV_MODEL_SETTINGS,
  jevModelEndpoint,
  type JevModelSettings as Settings,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";

const inputClass = "mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent disabled:opacity-50";

export function JevModelSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_JEV_MODEL_SETTINGS });
  const [saved, setSaved] = useState<JevModelSettingsDto | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const loaded = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    void getJson<JevModelSettingsDto>("/api/jev-model").then((dto) => {
      if (request !== generation.current) return;
      if (!loaded.current) setSettings(dto.settings);
      loaded.current = true;
      setSaved(dto);
      setError(null);
    }).catch(() => {
      if (request === generation.current) setError("Jevモデル設定を取得できません。設定画面を開き直してください。");
    });
    return () => { generation.current += 1; };
  }, [refreshToken]);

  const compatible = settings.provider === "compatible";
  const registered = settings.provider === "registered";
  const models = saved?.models ?? [];
  const selectionKey = settings.registeredModel ? jevModelKey(settings.registeredModel) : "";
  const selected = models.find((model) => jevModelKey(model) === selectionKey);
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

  function selectProvider(value: string) {
    if (value === "typesafe" || value === "compatible") return update({ provider: value });
    const model = models.find((candidate) => `registered:${jevModelKey(candidate)}` === value);
    if (model) update({
      provider: "registered",
      registeredModel: { providerId: model.providerId, modelId: model.modelId, ...(model.accountId ? { accountId: model.accountId } : {}) },
    });
  }

  async function refreshModels() {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const dto = await getJson<JevModelSettingsDto>("/api/jev-model", { refresh: "1" });
      if (request !== generation.current) return;
      setSaved(dto);
      setStatus("モデル一覧を更新しました。使用先は変更していません。");
    } catch {
      if (request === generation.current) setError("Jevモデル一覧を更新できません");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const dto = await sendJson<JevModelSettingsDto>("/api/jev-model", {
        settings,
        ...(!registered && removeKey ? { apiKey: null } : !registered && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }, "PUT");
      if (request !== generation.current) return;
      setSettings(dto.settings);
      setSaved(dto);
      setApiKey("");
      setRemoveKey(false);
      setStatus("保存しました。次のJev判定から反映されます。");
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Jevモデル設定を保存できません");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">Jevモデル</h3>
          <p className="text-xs text-muted">
            Autoモデル・エージェント選択、ラベル分類、Jev履歴圧縮、jev_judgeの共通接続先です。Composerには表示しません。既存プロバイダーのJev互換モデルは自動登録され、選択・保存後に既存のアカウント認証を使います。
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!saved || busy} onClick={() => void refreshModels()}>再読み込み</Button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!saved || busy} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Jevプロバイダー
              <select value={registered ? `registered:${selectionKey}` : settings.provider} onChange={(event) => selectProvider(event.target.value)} className={inputClass}>
                <option value="typesafe">TypeSafe（Jev）</option>
                <option value="compatible">Jev互換API（手動設定）</option>
                {models.length > 0 && <optgroup label="既存プロバイダー">
                  {models.map((model) => <option key={jevModelKey(model)} value={`registered:${jevModelKey(model)}`}>
                    {model.providerName}{model.accountLabel ? ` · ${model.accountLabel}` : ""} / {model.name}{model.source === "documented" ? "（公式対応）" : ""}
                  </option>)}
                </optgroup>}
                {registered && !selected && <option value={`registered:${selectionKey}`} disabled>{settings.registeredModel?.providerId} / {settings.registeredModel?.modelId}（未検出）</option>}
              </select>
            </label>
            <label className="text-xs text-muted">
              JevモデルID
              <input required maxLength={256} disabled={registered} value={registered ? settings.registeredModel?.modelId ?? "" : compatible ? settings.compatibleModel : settings.typesafeModel} onChange={(event) => update(compatible ? { compatibleModel: event.target.value } : { typesafeModel: event.target.value })} className={inputClass} />
            </label>
          </div>
          {compatible ? (
            <label className="block text-xs text-muted">
              APIベースURL（/systemoneを除く）
              <input required type="url" maxLength={2048} placeholder="http://localhost:8080/v1" value={settings.compatibleBaseUrl} onChange={(event) => update({ compatibleBaseUrl: event.target.value })} className={inputClass} />
            </label>
          ) : <p className="break-all text-xs text-muted">接続先: {registered ? selected ? `${selected.baseUrl}/systemone` : "未検出" : `${jevModelEndpoint(settings).baseUrl}/systemone`}</p>}
          <p className="text-xs text-muted">会話・ツール結果を送信するため、信頼できる接続先だけを指定してください。互換APIへの失敗時にTypeSafeへ転送することはありません。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {registered ? <p className="text-xs text-muted">選択したプロバイダー・アカウントの認証を使用します。キーの再入力は不要です。プラン・残高による利用制限は各社の条件に従います。</p> : <label className="text-xs text-muted">
              Jev APIキー{compatible ? "（認証不要なら空欄）" : ""}
              <input type="password" autoComplete="new-password" maxLength={4096} value={apiKey} placeholder={hasKey ? "設定済み（空欄で維持）" : "未設定"} disabled={removeKey} onChange={(event) => { setApiKey(event.target.value); setStatus(""); }} className={inputClass} />
            </label>}
            <label className="text-xs text-muted">
              タイムアウト（ミリ秒）
              <input required type="number" min={100} max={120000} step={100} value={settings.timeoutMs} onChange={(event) => update({ timeoutMs: Number(event.target.value) })} className={inputClass} />
            </label>
          </div>
          {!registered && <>
            <label className="flex min-h-11 items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={removeKey} onChange={(event) => { setRemoveKey(event.target.checked); setApiKey(""); setStatus(""); }} />
              選択した接続先の保存済みAPIキーを削除
            </label>
            <p className="text-xs text-muted">キーはサーバーの認証ストレージに保存します。互換APIのキーは接続URLごとに分離します。TypeSafeは既存キー・TYPESAFE_API_KEYを利用します。</p>
          </>}
          <Button type="submit" variant="secondary" size="sm">{busy ? "保存中…" : "Jevモデルを保存"}</Button>
        </fieldset>
      </form>
      {!saved && !error && <p role="status" className="text-sm text-muted">読み込み中…</p>}
      {status && <p role="status" className="text-xs text-muted">{status}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

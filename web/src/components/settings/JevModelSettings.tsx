"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { getJson, sendJson } from "@/lib/client";
import { jevModelKey, type JevCatalogModel } from "@/lib/jev-model-catalog";
import {
  DEFAULT_JEV_MODEL_SETTINGS,
  jevModelEndpoint,
  type JevModelSettings as Settings,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";

const inputClass = "mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent disabled:opacity-50";

type ModelRow = { key: string; id: string; name: string; baseUrl: string; source?: string; ref?: JevCatalogModel };
type ProviderRow = { key: string; id: string; name: string; accountLabel?: string; models: ModelRow[] };

function providerRows(settings: Settings, models: JevCatalogModel[]): ProviderRow[] {
  const rows: ProviderRow[] = [{
    key: "typesafe", id: "typesafe", name: "TypeSafe",
    models: [{ key: "typesafe", id: settings.typesafeModel, name: "Jev", baseUrl: jevModelEndpoint({ ...settings, provider: "typesafe" }).baseUrl }],
  }];
  const discovered = new Map<string, ProviderRow>();
  for (const model of models) {
    const key = JSON.stringify([model.accountId ?? null, model.providerId]);
    let row = discovered.get(key);
    if (!row) {
      row = { key, id: model.providerId, name: model.providerName, accountLabel: model.accountLabel, models: [] };
      discovered.set(key, row);
    }
    row.models.push({ key: jevModelKey(model), id: model.modelId, name: model.name, baseUrl: model.baseUrl, source: model.source, ref: model });
  }
  rows.push(...discovered.values(), {
    key: "compatible", id: "compatible", name: "Jev互換API（手動）",
    models: [{ key: "compatible", id: settings.compatibleModel, name: settings.compatibleModel, baseUrl: settings.compatibleBaseUrl }],
  });
  return rows;
}

export function JevModelSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_JEV_MODEL_SETTINGS });
  const [saved, setSaved] = useState<JevModelSettingsDto | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  const registered = settings.provider === "registered";
  const selectedKey = registered && settings.registeredModel ? jevModelKey(settings.registeredModel) : settings.provider;
  const savedKey = saved?.settings.provider === "registered" && saved.settings.registeredModel
    ? jevModelKey(saved.settings.registeredModel) : saved?.settings.provider;
  const rows = providerRows(settings, saved?.models ?? []);
  const searchTerm = query.trim().toLowerCase();
  const visibleRows = rows.flatMap((row) => {
    const matchesProvider = [row.name, row.id, row.accountLabel].some((value) => value?.toLowerCase().includes(searchTerm));
    const models = searchTerm && !matchesProvider
      ? row.models.filter((model) => [model.name, model.id].some((value) => value.toLowerCase().includes(searchTerm)))
      : row.models;
    return models.length ? [{ row, models, open: expanded.has(row.key) || Boolean(searchTerm) }] : [];
  });

  function update(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setStatus("");
    if ("provider" in patch || "compatibleBaseUrl" in patch) {
      setApiKey("");
      setRemoveKey(false);
    }
  }

  function selectModel(model: ModelRow) {
    if (model.key === "typesafe" || model.key === "compatible") return update({ provider: model.key });
    if (model.ref) update({
      provider: "registered",
      registeredModel: { providerId: model.ref.providerId, modelId: model.ref.modelId, ...(model.ref.accountId ? { accountId: model.ref.accountId } : {}) },
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
            Autoモデル・エージェント選択、ラベル分類、Jev履歴圧縮、jev_judgeの共通接続先を1つ選びます。既存プロバイダーの対応モデルは自動登録され、アカウントの認証を使います。Composerには表示しません。
            {saved && `（${rows.length} モデル枠・${rows.reduce((count, row) => count + row.models.length, 0)} モデル）`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!saved || busy} onClick={() => void refreshModels()}>再読み込み</Button>
      </div>
      {saved && <label className="block sm:max-w-sm">
        <span className="sr-only">Jevプロバイダー・モデルを検索</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロバイダー・モデルを検索" aria-label="Jevプロバイダー・モデルを検索" className={inputClass} />
      </label>}
      {!saved && !error && <p role="status" className="text-sm text-muted">読み込み中…</p>}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!saved || busy} className="space-y-4">
          {saved && searchTerm && visibleRows.length === 0 && <p className="text-sm text-muted">検索条件に一致する項目はありません。</p>}
          <ul className="space-y-3">
            {visibleRows.map(({ row, models, open }, index) => {
              const active = row.models.some((model) => model.key === savedKey);
              return <li key={row.key} className="space-y-2">
                <div className="flex min-h-20 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                  <button type="button" aria-expanded={open} aria-controls={`jev-models-${index}`} aria-label={`${row.name} のモデルを${open ? "折りたたむ" : "展開"}`} disabled={Boolean(searchTerm)} onClick={() => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
                    return next;
                  })} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:opacity-50">
                    <ChevronRight aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ProviderIcon providerID={row.id} size={16} />
                      <span className="text-sm font-medium">{row.name}</span>
                      <span className="font-mono text-xs text-muted">{row.id}</span>
                      {row.accountLabel && <span className="text-xs text-muted">アカウント: {row.accountLabel}</span>}
                      <Badge tone={active ? "success" : "neutral"}>{active ? "使用中" : "候補"}</Badge>
                    </div>
                  </div>
                </div>
                {open && <ul id={`jev-models-${index}`} className="space-y-2">
                  {models.map((model) => <li key={model.key} className="ml-4 rounded-xl border border-border border-l-2 border-l-border bg-surface px-4 py-3">
                    <label className="flex min-h-11 cursor-pointer items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{model.name}</span>
                          {model.key === savedKey && <Badge tone="success">使用中</Badge>}
                          {model.source === "documented" && <span className="text-xs text-muted">公式対応</span>}
                        </div>
                        <p className="break-all font-mono text-xs text-muted">{model.id}</p>
                      </div>
                      <input type="radio" name="jev-model" checked={selectedKey === model.key} onChange={() => selectModel(model)} aria-label={`${row.name}${row.accountLabel ? ` · ${row.accountLabel}` : ""} / ${model.name} を選択`} className="h-5 w-5 shrink-0 accent-accent" />
                    </label>
                    {model.key === "typesafe" || model.key === "compatible" ? <div className="mt-2 space-y-3 border-t border-border pt-3">
                      <label className="block text-xs text-muted">モデルID
                        <input required maxLength={256} disabled={selectedKey !== model.key} value={model.key === "typesafe" ? settings.typesafeModel : settings.compatibleModel} onChange={(event) => update(model.key === "typesafe" ? { typesafeModel: event.target.value } : { compatibleModel: event.target.value })} className={inputClass} />
                      </label>
                      {model.key === "typesafe" && <p className="break-all text-xs text-muted">接続先: {model.baseUrl}/systemone</p>}
                      {model.key === "compatible" && <label className="block text-xs text-muted">APIベースURL（/systemoneを除く）
                        <input type="url" required disabled={selectedKey !== "compatible"} maxLength={2048} placeholder="http://localhost:8080/v1" value={settings.compatibleBaseUrl} onChange={(event) => update({ compatibleBaseUrl: event.target.value })} className={inputClass} />
                      </label>}
                      <label className="block text-xs text-muted">Jev APIキー{model.key === "compatible" ? "（認証不要なら空欄）" : ""}
                        <input type="password" autoComplete="new-password" maxLength={4096} value={apiKey} placeholder={(model.key === "typesafe" ? saved?.hasApiKey.typesafe : saved?.settings.compatibleBaseUrl === settings.compatibleBaseUrl && saved?.hasApiKey.compatible) ? "設定済み（空欄で維持）" : "未設定"} disabled={removeKey || selectedKey !== model.key} onChange={(event) => { setApiKey(event.target.value); setStatus(""); }} className={inputClass} />
                      </label>
                      <label className="flex min-h-11 items-center gap-2 text-xs text-muted">
                        <input type="checkbox" checked={removeKey && selectedKey === model.key} disabled={selectedKey !== model.key} onChange={(event) => { setRemoveKey(event.target.checked); setApiKey(""); setStatus(""); }} />
                        選択した接続先の保存済みAPIキーを削除
                      </label>
                      <p className="text-xs text-muted">キーはサーバーの認証ストレージに保存します。互換APIのキーは接続URLごとに分離します。TypeSafeは既存キー・TYPESAFE_API_KEYを利用します。</p>
                    </div> : <p className="mt-2 break-all text-xs text-muted">接続先: {model.baseUrl}/systemone · 既存アカウント認証を使用（プラン・残高による利用制限は各社に準拠）</p>}
                  </li>)}
                </ul>}
              </li>;
            })}
          </ul>
          {registered && !rows.some((row) => row.models.some((model) => model.key === selectedKey)) && <p role="alert" className="text-sm text-danger">選択中のJevモデルが未検出です。再検出または別のモデルを選択してください。</p>}
          <div className="space-y-3 rounded-xl border border-border bg-surface px-4 py-3">
            <label className="block max-w-xs text-xs text-muted">タイムアウト（ミリ秒）
              <input required type="number" min={100} max={120000} step={100} value={settings.timeoutMs} onChange={(event) => update({ timeoutMs: Number(event.target.value) })} className={inputClass} />
            </label>
            <p className="text-xs text-muted">会話・ツール結果を送信するため信頼できる接続先だけを選んでください。失敗時に別のJevプロバイダーへ転送しません。</p>
            <Button type="submit" variant="secondary" size="sm" disabled={registered && !rows.some((row) => row.models.some((model) => model.key === selectedKey))}>{busy ? "保存中…" : "Jevモデルを保存"}</Button>
          </div>
        </fieldset>
      </form>
      {status && <p role="status" className="text-xs text-muted">{status}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

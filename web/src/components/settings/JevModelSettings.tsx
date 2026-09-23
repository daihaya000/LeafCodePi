"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { getJson, sendJson } from "@/lib/client";
import { jevModelKey, type JevCatalogModel } from "@/lib/jev-model-catalog";
import {
  DEFAULT_JEV_MODEL_SETTINGS,
  type JevModelSettings as Settings,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";

const inputClass = "h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent";

type ProviderRow = { key: string; id: string; name: string; accountLabel?: string; enabled: boolean; models: JevCatalogModel[] };

function providerRows(models: JevCatalogModel[]): ProviderRow[] {
  const rows = new Map<string, ProviderRow>();
  for (const model of models) {
    const key = JSON.stringify([model.accountId ?? null, model.providerId]);
    let row = rows.get(key);
    if (!row) {
      row = { key, id: model.providerId, name: model.providerName, accountLabel: model.accountLabel, enabled: model.providerEnabled !== false, models: [] };
      rows.set(key, row);
    }
    row.models.push(model);
  }
  return [...rows.values()];
}

function selectedModelKey(settings: Settings, models: JevCatalogModel[]): string | undefined {
  if (settings.provider === "registered") return settings.registeredModel && jevModelKey(settings.registeredModel);
  // Existing TypeSafe choices remain active; credentials are already owned by the provider panel.
  if (settings.provider === "typesafe") return models.find((model) => model.providerId === "typesafe" && model.modelId === settings.typesafeModel)?.modelId;
  return undefined;
}

export function JevModelSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_JEV_MODEL_SETTINGS });
  const [saved, setSaved] = useState<JevModelSettingsDto | null>(null);
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

  const models = saved?.models ?? [];
  const rows = providerRows(models);
  const selectedKey = selectedModelKey(settings, models);
  const savedKey = saved && selectedModelKey(saved.settings, models);
  const chosen = models.find((model) => (settings.provider === "typesafe" ? model.providerId === "typesafe" && model.modelId === selectedKey : jevModelKey(model) === selectedKey));
  const selectionUnavailable = settings.provider === "registered" && (!chosen || chosen.providerEnabled === false);
  const searchTerm = query.trim().toLowerCase();
  const visibleRows = rows.flatMap((row) => {
    const matchesProvider = [row.name, row.id, row.accountLabel].some((value) => value?.toLowerCase().includes(searchTerm));
    const matches = searchTerm && !matchesProvider
      ? row.models.filter((model) => [model.name, model.modelId].some((value) => value.toLowerCase().includes(searchTerm)))
      : row.models;
    return matches.length ? [{ row, models: matches, open: expanded.has(row.key) || Boolean(searchTerm) }] : [];
  });

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
      const dto = await sendJson<JevModelSettingsDto>("/api/jev-model", { settings }, "PUT");
      if (request !== generation.current) return;
      setSettings(dto.settings);
      setSaved(dto);
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
            Jev判定の使用先を選びます。接続先・認証・有効状態は<a href="#models-providers" className="text-accent hover:underline">プロバイダー接続</a>と<a href="#models-catalog" className="text-accent hover:underline">モデル</a>で管理します。Composerには表示しません。
            {saved && `（${rows.length} モデル枠・${models.length} モデル）`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!saved || busy} onClick={() => void refreshModels()}>再読み込み</Button>
      </div>
      {saved && <label className="block sm:max-w-sm">
        <span className="sr-only">Jevプロバイダー・モデルを検索</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロバイダー・モデルを検索" aria-label="Jevプロバイダー・モデルを検索" className={inputClass} />
      </label>}
      {!saved && !error && <p role="status" className="text-sm text-muted">読み込み中…</p>}
      {saved && models.length === 0 && <p className="text-sm text-muted">利用できるJevモデルがありません。プロバイダー接続で認証を登録してください。</p>}
      {saved && searchTerm && visibleRows.length === 0 && <p className="text-sm text-muted">検索条件に一致する項目はありません。</p>}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!saved || busy} className="space-y-4">
          <ul className="space-y-3">
            {visibleRows.map(({ row, models: matchingModels, open }, index) => <li key={row.key} className="space-y-2">
              <div className="grid min-h-20 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                <button type="button" aria-expanded={open} aria-controls={`jev-models-${index}`} aria-label={`${row.name} のモデルを${open ? "折りたたむ" : "展開"}`} disabled={Boolean(searchTerm)} onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
                  return next;
                })} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:opacity-50">
                  <ChevronRight aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
                </button>
                <div className="min-w-0 flex flex-wrap items-center gap-2">
                  <ProviderIcon providerID={row.id} size={16} />
                  <span className="text-sm font-medium">{row.name}</span>
                  <span className="font-mono text-xs text-muted">{row.id}</span>
                  {row.accountLabel && <span className="text-xs text-muted">アカウント: {row.accountLabel}</span>}
                  <Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "有効" : "無効"}</Badge>
                </div>
              </div>
              {open && <ul id={`jev-models-${index}`} className="space-y-2">
                {matchingModels.map((model) => {
                  const key = jevModelKey(model);
                  const checked = settings.provider === "typesafe" ? model.providerId === "typesafe" && model.modelId === selectedKey : key === selectedKey;
                  const active = saved?.settings.provider === "typesafe" ? model.providerId === "typesafe" && model.modelId === savedKey : key === savedKey;
                  return <li key={key} className={`ml-4 rounded-xl border border-border border-l-2 border-l-border bg-surface px-4 py-3 ${row.enabled ? "" : "opacity-50"}`}>
                    <label className={`flex min-h-11 items-center gap-3 ${row.enabled ? "cursor-pointer" : "cursor-not-allowed"}`}>
                      <span aria-hidden="true" className="w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{model.name}</span>
                          <Badge tone={active ? "success" : "neutral"}>{active ? "使用中" : checked ? "選択中" : "候補"}</Badge>
                          {model.source === "documented" && <span className="text-xs text-muted">公式対応</span>}
                        </span>
                        <span className="block break-all font-mono text-xs text-muted">{model.modelId}</span>
                      </span>
                      <input type="radio" name="jev-model" checked={checked} disabled={!row.enabled} onChange={() => {
                        setSettings((current) => ({ ...current, provider: "registered", registeredModel: {
                          providerId: model.providerId, modelId: model.modelId, ...(model.accountId ? { accountId: model.accountId } : {}),
                        } }));
                        setStatus("");
                      }} aria-label={`${row.name}${row.accountLabel ? ` · ${row.accountLabel}` : ""} / ${model.name} を選択`} className="h-5 w-5 shrink-0 accent-accent" />
                    </label>
                  </li>;
                })}
              </ul>}
            </li>)}
          </ul>
          {selectionUnavailable && <p role="alert" className="text-sm text-danger">選択中のモデルは未検出、またはモデル側で無効です。別のモデルを選ぶか、モデル側で有効にしてください。</p>}
          {settings.provider === "compatible" && <p className="text-xs text-muted">従来の手動接続先を使用中です。この一覧では接続先を編集できません。切り替える場合は既存プロバイダーのモデルを選んでください。</p>}
          {settings.provider === "typesafe" && !selectedKey && <p className="text-xs text-muted">従来のTypeSafeモデルを使用中です。認証はプロバイダー接続で管理してください。</p>}
          <p className="text-xs text-muted">会話・ツール結果を選択したプロバイダーへ送信します。失敗時に別の接続先へ転送しません。</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" size="sm" disabled={selectionUnavailable}>{busy ? "保存中…" : "Jevモデルを保存"}</Button>
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Jev判定の詳細設定</summary>
              <label className="mt-2 block max-w-xs">タイムアウト（ミリ秒）
                <input required type="number" min={100} max={120000} step={100} value={settings.timeoutMs} onChange={(event) => setSettings((current) => ({ ...current, timeoutMs: Number(event.target.value) }))} className={`mt-1 ${inputClass}`} />
              </label>
            </details>
          </div>
        </fieldset>
      </form>
      {status && <p role="status" className="text-xs text-muted">{status}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { Badge, Button, Switch, cx } from "@/components/ui";
import { ReorderButtons } from "@/components/settings/ProviderModelsPanel";
import type { ProviderModelsRow } from "@/lib/provider-models";
import { ProviderIcon } from "@/components/ProviderIcon";
import { getJson, sendJson } from "@/lib/client";
import { jevModelKey, type JevCatalogModel } from "@/lib/jev-model-catalog";
import {
  DEFAULT_JEV_MODEL_SETTINGS,
  type JevModelSettings as Settings,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";

const inputClass = "h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent";

type ProviderRow = { key: string; id: string; name: string; accountId?: string; accountLabel?: string; enabled: boolean; models: JevCatalogModel[] };

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return items;
  next.splice(to, 0, item);
  return next;
}

function providerKey(row: { id: string; accountId?: string }): string {
  return row.accountId ? `${row.accountId}::${row.id}` : row.id;
}

function providerRows(models: JevCatalogModel[]): ProviderRow[] {
  const rows = new Map<string, ProviderRow>();
  for (const model of models) {
    const key = model.integrated ? model.providerId : providerKey({ id: model.providerId, accountId: model.accountId });
    let row = rows.get(key);
    if (!row) {
      row = { key, id: model.providerId, name: model.providerName, ...(model.integrated ? {} : { accountId: model.accountId, accountLabel: model.accountLabel }), enabled: model.providerEnabled !== false, models: [] };
      rows.set(key, row);
    }
    row.models.push(model);
    if (model.providerEnabled !== false) row.enabled = true;
  }
  return [...rows.values()];
}

function enabledModelKeys(settings: Settings, models: JevCatalogModel[]): Set<string> {
  if (settings.enabledModels) return new Set(settings.enabledModels.map(jevModelKey));
  if (settings.provider === "registered") return new Set(settings.registeredModel ? [jevModelKey(settings.registeredModel)] : []);
  const legacy = settings.provider === "typesafe" && models.find((model) => model.providerId === "typesafe" && model.modelId === settings.typesafeModel);
  return new Set(legacy ? [jevModelKey(legacy)] : []);
}

export function JevModelSettings({ refreshToken = 0, onProviderCatalogChange }: { refreshToken?: number; onProviderCatalogChange?: () => void }) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_JEV_MODEL_SETTINGS });
  const [saved, setSaved] = useState<JevModelSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<{ rowKey: string; modelKey?: string } | null>(null);
  const loaded = useRef(false);
  const generation = useRef(0);
  const lastRefreshToken = useRef(refreshToken);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const persisted = useRef<string | null>(null);
  const savingNow = useRef(false);
  const canSave = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const applyDto = useCallback((dto: JevModelSettingsDto) => {
    if (!savingNow.current) {
      const clean = JSON.stringify(latestSettings.current) === persisted.current;
      persisted.current = JSON.stringify(dto.settings);
      if (!loaded.current || clean) {
        latestSettings.current = dto.settings;
        setSettings(dto.settings);
      }
    }
    loaded.current = true;
    setSaved(dto);
  }, []);

  useEffect(() => {
    const request = ++generation.current;
    const changed = lastRefreshToken.current !== refreshToken;
    lastRefreshToken.current = refreshToken;
    void getJson<JevModelSettingsDto>("/api/jev-model", undefined, changed ? { coalesce: false } : undefined).then((dto) => {
      if (request !== generation.current) return;
      applyDto(dto);
      setError(null);
    }).catch(() => {
      if (request === generation.current) setError("Jevモデル設定を取得できません。設定画面を開き直してください。");
    });
    return () => { generation.current += 1; };
  }, [refreshToken, applyDto]);

  const models = saved?.models ?? [];
  const rows = providerRows(models);
  const selectedKeys = enabledModelKeys(settings, models);
  const savedKeys = saved ? enabledModelKeys(saved.settings, models) : new Set<string>();
  const selectionUnavailable = settings.provider === "registered" && (selectedKeys.size === 0 ||
    [...selectedKeys].some((key) => !models.some((model) => jevModelKey(model) === key && model.providerEnabled !== false)));
  const timeoutInvalid = !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 100 || settings.timeoutMs > 120_000;
  canSave.current = Boolean(saved) && !selectionUnavailable && !timeoutInvalid;
  const persist = useCallback(async function persist() {
    const next = latestSettings.current;
    const snapshot = JSON.stringify(next);
    if (savingNow.current || !canSave.current || snapshot === persisted.current) return;
    // Catalog reads started before or during this write must not overwrite its result.
    generation.current += 1;
    savingNow.current = true;
    if (mounted.current) { setError(null); setStatus("保存中…"); }
    try {
      const dto = await sendJson<JevModelSettingsDto>("/api/jev-model", { settings: next }, "PUT");
      persisted.current = JSON.stringify(dto.settings);
      if (mounted.current) {
        setSaved(dto);
        if (JSON.stringify(latestSettings.current) === snapshot) {
          latestSettings.current = dto.settings;
          setSettings(dto.settings);
          setStatus("自動保存しました。次のJev判定から反映されます。");
        }
      }
    } catch (cause) {
      if (mounted.current && JSON.stringify(latestSettings.current) === snapshot) {
        setStatus("");
        setError(cause instanceof Error ? cause.message : "Jevモデル設定を保存できません");
      }
    } finally {
      generation.current += 1;
      savingNow.current = false;
      if (JSON.stringify(latestSettings.current) !== snapshot) void persist();
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void persist();
      }
    };
  }, [persist]);
  useEffect(() => {
    if (!loaded.current || !saved || !canSave.current || JSON.stringify(settings) === persisted.current) return;
    const timer = setTimeout(() => { saveTimer.current = null; void persist(); }, 350);
    saveTimer.current = timer;
    return () => {
      clearTimeout(timer);
      if (saveTimer.current === timer) saveTimer.current = null;
    };
  }, [settings, saved, persist]);
  const searchTerm = query.trim().toLowerCase();
  const visibleRows = rows.flatMap((row) => {
    const matchesProvider = [row.name, row.id, row.accountLabel].some((value) => value?.toLowerCase().includes(searchTerm));
    const matches = searchTerm && !matchesProvider
      ? row.models.filter((model) => [model.name, model.modelId, model.accountLabel].some((value) => value?.toLowerCase().includes(searchTerm)))
      : row.models;
    return matches.length ? [{ row, models: matches, open: expanded.has(row.key) || Boolean(searchTerm) }] : [];
  });

  async function changeCatalog(action: (providers: ProviderModelsRow[]) => Promise<void>) {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const { providers } = await getJson<{ providers: ProviderModelsRow[] }>("/api/provider-models");
      await action(providers);
      onProviderCatalogChange?.();
      const dto = await getJson<JevModelSettingsDto>("/api/jev-model", undefined, { coalesce: false });
      if (request === generation.current) applyDto(dto);
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "モデル設定を変更できません");
    } finally {
      setBusy(false);
    }
  }

  function toggleModel(model: JevCatalogModel) {
    const ref = { providerId: model.providerId, modelId: model.modelId, ...(model.accountId ? { accountId: model.accountId } : {}) };
    if (selectedKeys.has(jevModelKey(ref)) && selectedKeys.size === 1) {
      setError("有効なJevモデルを1件以上残してください");
      return;
    }
    if (!selectedKeys.has(jevModelKey(ref)) && selectedKeys.size >= 64) {
      setError("有効なJevモデルは64件までです");
      return;
    }
    setError(null);
    setSettings((current) => {
      const keys = enabledModelKeys(current, models);
      const refs = current.enabledModels ?? models.filter((item) => keys.has(jevModelKey(item))).map((item) => ({
        providerId: item.providerId, modelId: item.modelId, ...(item.accountId ? { accountId: item.accountId } : {}),
      }));
      const next = keys.has(jevModelKey(ref)) ? refs.filter((item) => jevModelKey(item) !== jevModelKey(ref)) : [...refs, ref];
      return { ...current, provider: "registered", registeredModel: next[0], enabledModels: next };
    });
    setStatus("");
  }

  function toggleProvider(row: ProviderRow) {
    void changeCatalog(async (providers) => {
      const provider = providers.find((item) => providerKey(item) === row.key);
      await sendJson(`/api/provider-models/${encodeURIComponent(row.id)}`, {
        enabled: !row.enabled,
        ...(!row.enabled ? { modelIds: provider?.models.map((model) => model.id) ?? [] } : {}),
        ...(row.accountId ? { accountId: row.accountId } : {}),
      }, "PATCH");
    });
  }

  function moveRow(row: ProviderRow, target: ProviderRow) {
    if (row.key === target.key) return;
    void changeCatalog(async (providers) => {
      const order = providers.map(providerKey);
      for (const [index, item] of rows.entries()) {
        if (order.includes(item.key)) continue;
        const next = rows.slice(index + 1).find((candidate) => order.includes(candidate.key));
        order.splice(next ? order.indexOf(next.key) : order.length, 0, item.key);
      }
      const next = moveItem(order, order.indexOf(row.key), order.indexOf(target.key));
      await sendJson("/api/provider-models/order", { providerOrder: next }, "PATCH");
    });
  }

  function moveModel(row: ProviderRow, model: JevCatalogModel, target: JevCatalogModel) {
    if (model.accountId !== target.accountId || jevModelKey(model) === jevModelKey(target)) return;
    void changeCatalog(async (providers) => {
      const provider = providers.find((item) => providerKey(item) === (model.integrated ? row.id : row.key));
      const modelIds = provider?.models.map((item) => item.id) ?? [];
      const sameAccount = row.models.filter((item) => item.accountId === model.accountId);
      const next = moveItem(sameAccount, sameAccount.findIndex((item) => jevModelKey(item) === jevModelKey(model)), sameAccount.findIndex((item) => jevModelKey(item) === jevModelKey(target)));
      const order = [...modelIds, ...next.map((item) => item.modelId)];
      await sendJson("/api/provider-models/order", model.accountId
        ? { accountModelOrder: { [model.accountId]: { [row.id]: order } } }
        : { modelOrder: { [row.id]: order } }, "PATCH");
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
      applyDto(dto);
      setStatus("モデル一覧を更新しました。使用先は変更していません。");
    } catch {
      if (request === generation.current) setError("Jevモデル一覧を更新できません");
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
            有効なJevモデルを上から順に試します。接続先・認証は<a href="#models-providers" className="text-accent hover:underline">プロバイダー接続</a>、プロバイダー状態・表示順はモデル一覧と共通です。Composerには表示しません。
            {saved && `（${rows.length} モデル枠・${models.length} モデル）`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!saved || busy} onClick={() => void refreshModels()}>再読み込み</Button>
      </div>
      {saved && <label className="block @xl:max-w-sm">
        <span className="sr-only">Jevプロバイダー・モデルを検索</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロバイダー・モデルを検索" aria-label="Jevプロバイダー・モデルを検索" className={inputClass} />
      </label>}
      {!saved && !error && <p role="status" className="text-sm text-muted">読み込み中…</p>}
      {saved && models.length === 0 && <p className="text-sm text-muted">利用できるJevモデルがありません。プロバイダー接続で認証を登録してください。</p>}
      {saved && searchTerm && visibleRows.length === 0 && <p className="text-sm text-muted">検索条件に一致する項目はありません。</p>}
      <fieldset disabled={!saved || busy} className="space-y-4">
          <ul className="space-y-3">
            {visibleRows.map(({ row, models: matchingModels, open }, index) => <li key={row.key} className="space-y-2" draggable={!busy && !searchTerm} onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              setDragging({ rowKey: row.key });
            }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
              event.preventDefault();
              const source = rows.find((item) => item.key === dragging?.rowKey);
              if (source && !dragging?.modelKey && !searchTerm) moveRow(source, row);
              setDragging(null);
            }}>
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 @xl:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
                <div className="flex items-center gap-1">
                  <GripVertical aria-hidden="true" className="h-4 w-4 shrink-0 cursor-grab text-muted" />
                  <button type="button" aria-expanded={open} aria-controls={`jev-models-${index}`} aria-label={`${row.name} のモデルを${open ? "折りたたむ" : "展開"}`} disabled={Boolean(searchTerm)} onClick={() => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
                    return next;
                  })} className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:opacity-50">
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className={cx("h-4 w-4 transition-transform", open ? "rotate-90" : "rotate-0")}>
                      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <ProviderIcon providerID={row.id} size={16} />
                    <p className="min-w-0 truncate text-sm font-medium">{row.name}</p>
                    <span className="font-mono text-xs text-muted">{row.id}</span>
                    {row.accountLabel && <span className="text-xs text-muted">アカウント: {row.accountLabel}</span>}
                    <Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "有効" : "無効"}</Badge>
                  </div>
                </div>
                <Switch checked={row.enabled} onChange={() => toggleProvider(row)} label={`${row.name}${row.accountLabel ? ` · ${row.accountLabel}` : ""} を${row.enabled ? "無効化" : "有効化"}`} busy={busy} />
                <ReorderButtons label={row.name} index={rows.findIndex((item) => item.key === row.key)} count={rows.length} busy={busy || Boolean(searchTerm)} onMove={(direction) => {
                  const target = rows[rows.findIndex((item) => item.key === row.key) + direction];
                  if (target) moveRow(row, target);
                }} className="col-start-2 col-span-2 row-start-2 justify-self-end @xl:col-start-4 @xl:col-span-1 @xl:row-start-1" />
              </div>
              {open && <ul id={`jev-models-${index}`} className="space-y-2">
                {matchingModels.map((model) => {
                  const key = jevModelKey(model);
                  const checked = selectedKeys.has(key);
                  const active = savedKeys.has(key);
                  const modelEnabled = model.providerEnabled !== false;
                  const siblingModels = row.models.filter((item) => item.accountId === model.accountId);
                  const modelIndex = siblingModels.findIndex((item) => jevModelKey(item) === key);
                  const targetIndex = (direction: -1 | 1) => {
                    const target = siblingModels[modelIndex + direction];
                    if (target) moveModel(row, model, target);
                  };
                  return <li key={key} draggable={!busy && !searchTerm && row.enabled} onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = "move";
                    setDragging({ rowKey: row.key, modelKey: key });
                  }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const source = row.models.find((item) => jevModelKey(item) === dragging?.modelKey);
                    if (source && dragging?.rowKey === row.key && !searchTerm) moveModel(row, source, model);
                    setDragging(null);
                  }} className={cx(
                    "ml-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-xl border border-border border-l-2 border-l-border bg-surface px-4 py-3 @xl:flex @xl:items-center @xl:gap-3",
                    !modelEnabled && "opacity-50",
                  )}>
                    <GripVertical aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 cursor-grab text-muted @xl:mt-0" />
                    <div className="col-span-2 flex min-w-0 flex-1 items-center gap-3 @xl:col-auto">
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">{model.name}</span>
                        {model.integrated && model.accountLabel && <span className="text-xs text-muted">アカウント: {model.accountLabel}</span>}
                        <Badge tone={checked ? "success" : "neutral"}>{checked ? active ? "有効" : "有効（未反映）" : active ? "無効（未反映）" : "無効"}</Badge>
                        {model.source === "documented" && <span className="text-xs text-muted">公式対応</span>}
                        <span className="break-all font-mono text-xs text-muted">{model.modelId}</span>
                      </span>
                      <Switch checked={checked} disabled={!modelEnabled && !checked} onChange={() => toggleModel(model)} label={`${row.name}${row.accountLabel || model.integrated && model.accountLabel ? ` · ${row.accountLabel ?? model.accountLabel}` : ""} / ${model.name} を${checked ? "無効化" : "有効化"}`} />
                    </div>
                    <ReorderButtons label={`${row.name} の ${model.name}`} index={modelIndex} count={siblingModels.length} busy={busy || Boolean(searchTerm)} onMove={targetIndex} className="col-start-3 row-start-2 justify-self-end @xl:col-auto @xl:row-auto" />
                  </li>;
                })}
              </ul>}
            </li>)}
          </ul>
          {selectionUnavailable && <p role="alert" className="text-sm text-danger">有効なJevモデルを1件以上選び、対象プロバイダーを有効にしてください。</p>}
          {timeoutInvalid && <p role="alert" className="text-sm text-danger">タイムアウトは100〜120000ミリ秒で指定してください。</p>}
          {settings.provider === "compatible" && <p className="text-xs text-muted">従来の手動接続先を使用中です。この一覧では接続先を編集できません。切り替える場合は既存プロバイダーのモデルを選んでください。</p>}
          {settings.provider === "typesafe" && selectedKeys.size === 0 && <p className="text-xs text-muted">従来のTypeSafeモデルを使用中です。認証はプロバイダー接続で管理してください。</p>}
          <p className="text-xs text-muted">会話・ツール結果を有効なモデルへ上から順に送信します。失敗すると次の有効モデルへ転送します。</p>
          <div className="flex flex-wrap items-center gap-3">
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Jev判定の詳細設定</summary>
              <label className="mt-2 block max-w-xs">タイムアウト（ミリ秒）
                <input type="number" min={100} max={120000} step={100} value={settings.timeoutMs} onChange={(event) => { setSettings((current) => ({ ...current, timeoutMs: Number(event.target.value) })); setError(null); setStatus(""); }} className={`mt-1 ${inputClass}`} />
              </label>
            </details>
          </div>
      </fieldset>
      {status && <p role="status" className="text-xs text-muted">{status}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}{canSave.current && JSON.stringify(settings) !== persisted.current && <> <button type="button" onClick={() => void persist()} className="text-accent underline">再試行</button></>}</p>}
    </div>
  );
}

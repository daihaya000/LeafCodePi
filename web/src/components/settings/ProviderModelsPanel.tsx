"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { Badge, Button, GhostSelect, Switch, cx } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ApiError, getJson, sendJson } from "@/lib/client";
import {
  ALL_THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  isThinkingLevel,
} from "@/lib/thinking-levels";
import type { ProviderModelRow, ProviderModelsRow } from "@shared/ui-owner-dtos";
import type { ThinkingLevel } from "@/lib/types";

type DragState =
  | { kind: "provider"; rowKey: string }
  | { kind: "model"; rowKey: string; id: string };

type ResetCreditDto = {
  expiresAt: string | null;
};

type ResetCreditsListResponse = {
  credits?: ResetCreditDto[];
};

const RESET_CREDIT_DAY_MS = 24 * 60 * 60 * 1000;

function earliestResetExpiry(
  credits: readonly ResetCreditDto[],
): string | null {
  let earliest: { expiresAt: string; timestamp: number } | null = null;
  for (const credit of credits) {
    if (!credit.expiresAt) continue;
    const timestamp = Date.parse(credit.expiresAt);
    if (!Number.isFinite(timestamp)) continue;
    if (!earliest || timestamp < earliest.timestamp) {
      earliest = { expiresAt: credit.expiresAt, timestamp };
    }
  }
  return earliest?.expiresAt ?? null;
}

function formatResetCreditRemainingDays(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const remainingDays = Math.ceil(
    (Date.parse(expiresAt) - Date.now()) / RESET_CREDIT_DAY_MS,
  );
  if (!Number.isFinite(remainingDays)) return null;
  return remainingDays > 0
    ? `最短期限まであと${remainingDays}日`
    : "最短期限が切れています";
}

function ResetCreditExpiry({
  provider,
  accountId,
  accountIds,
}: {
  provider: string;
  accountId?: string;
  accountIds?: readonly string[];
}) {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  useEffect(() => {
    const requestParams = accountIds
      ? [...new Set(accountIds)].map((id) => ({ accountId: id, provider }))
      : [{ accountId, provider }];
    if (requestParams.length === 0) {
      setExpiresAt(null);
      return;
    }

    let active = true;
    void Promise.allSettled(
      requestParams.map((params) =>
        getJson<ResetCreditsListResponse>(
          "/api/codexbar/reset-credits",
          params,
        ),
      ),
    ).then((results) => {
      if (!active) return;
      const credits = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value.credits ?? [] : [],
      );
      setExpiresAt(earliestResetExpiry(credits));
    });
    return () => {
      active = false;
    };
  }, [accountId, accountIds, provider]);

  const remainingDays = formatResetCreditRemainingDays(expiresAt);
  return remainingDays ? (
    <p className="mt-1 text-[11px] text-muted">リセット権: {remainingDays}</p>
  ) : null;
}

function providerRowKey(provider: ProviderModelsRow): string {
  return provider.accountId ? `${provider.accountId}::${provider.id}` : provider.id;
}

function providerDisplayName(provider: ProviderModelsRow): string {
  return provider.accountLabel
    ? `${provider.name} · ${provider.accountLabel}`
    : provider.name;
}

function effortLevelsForModel(model: ProviderModelRow): ThinkingLevel[] {
  const allowed = new Set<ThinkingLevel>(model.thinkingLevels ?? []);
  if (model.defaultThinkingLevel) allowed.add(model.defaultThinkingLevel);
  return ALL_THINKING_LEVELS.filter((level) => allowed.has(level));
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return items;
  next.splice(to, 0, item);
  return next;
}

export function ReorderButtons({
  label,
  index,
  count,
  busy,
  className,
  onMove,
}: {
  label: string;
  index: number;
  count: number;
  busy: boolean;
  className?: string;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <div className={cx("flex items-center gap-1", className)}>
      <button
        type="button"
        aria-label={`${label} を上へ`}
        title="上へ"
        disabled={busy || index === 0}
        onClick={() => onMove(-1)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 @xl:h-7 @xl:w-7"
      >
        <ChevronUp aria-hidden="true" className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={`${label} を下へ`}
        title="下へ"
        disabled={busy || index >= count - 1}
        onClick={() => onMove(1)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 @xl:h-7 @xl:w-7"
      >
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

function touchDropTarget(source: DragState, x: number, y: number): DragState | null {
  const element = document.elementFromPoint(x, y);
  const providerKey = element?.closest("[data-provider-row]")?.getAttribute("data-provider-row");
  if (!providerKey) return null;
  if (source.kind === "provider") return { kind: "provider", rowKey: providerKey };
  if (source.rowKey !== providerKey) return null;
  const id = element?.closest("[data-model-row]")?.getAttribute("data-model-row");
  return id ? { kind: "model", rowKey: providerKey, id } : null;
}

function ProviderRow({
  provider,
  providerIndex,
  providerCount,
  visibleModels,
  searchExpanded,
  busyId,
  onToggleProvider,
  onToggleModel,
  onDefaultThinkingLevelChange,
  onMoveProvider,
  onMoveModel,
  onDragStartProvider,
  onDropProvider,
  onDragStartModel,
  onDropModel,
  touchTarget,
}: {
  provider: ProviderModelsRow;
  providerIndex: number;
  providerCount: number;
  visibleModels: ProviderModelRow[];
  searchExpanded: boolean;
  busyId: string | null;
  onToggleProvider: (enabled: boolean) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onDefaultThinkingLevelChange: (modelId: string, level: ThinkingLevel | null) => void;
  onMoveProvider: (direction: -1 | 1) => void;
  onMoveModel: (modelId: string, direction: -1 | 1) => void;
  onDragStartProvider: () => void;
  onDropProvider: () => void;
  onDragStartModel: (modelId: string) => void;
  onDropModel: (modelId: string) => void;
  touchTarget: DragState | null;
}) {
  // 既定は折りたたみ。プロバイダーが増えると全展開では一覧が長くなるため。
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (searchExpanded) setExpanded(true);
  }, [searchExpanded]);
  const panelId = useId();
  const rowKey = providerRowKey(provider);
  const displayName = providerDisplayName(provider);
  const isBusy = busyId === rowKey || busyId?.startsWith(`${rowKey}::`) === true;
  const hasModels = provider.models.length > 0;

  return (
    <li
      aria-busy={isBusy || undefined}
      data-provider-row={rowKey}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStartProvider();
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDropProvider();
      }}
      className="space-y-2"
    >
      <div className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 @xl:grid-cols-[auto_minmax(0,1fr)_auto_auto]", touchTarget?.kind === "provider" && touchTarget.rowKey === rowKey && "ring-2 ring-accent")}>
        <div className="flex items-center gap-1">
          <span
            data-reorder-provider={isBusy ? undefined : rowKey}
            aria-hidden="true"
            className="-m-2 inline-flex h-11 w-8 touch-none items-center justify-center rounded-lg text-muted active:text-accent @xl:h-7 @xl:w-5"
          >
            <GripVertical className="h-4 w-4 cursor-grab" />
          </span>
          {hasModels && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={`${displayName} のモデルを${expanded ? "折りたたむ" : "展開"}`}
              onClick={() => setExpanded((value) => !value)}
              className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={cx("h-4 w-4 transition-transform", expanded ? "rotate-90" : "rotate-0")}
              >
                <path
                  fillRule="evenodd"
                  d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon providerID={provider.id} size={16} />
            <p className="min-w-0 truncate text-sm font-medium">{provider.name}</p>
            <span className="text-xs text-muted">{provider.id}</span>
            {provider.accountLabel && (
              <span className="text-xs text-muted">アカウント: {provider.accountLabel}</span>
            )}
            <Badge tone={provider.enabled ? "success" : "neutral"}>
              {provider.enabled ? "有効" : "無効"}
            </Badge>
          </div>
          {(provider.id === "openai-codex" || provider.id === "anthropic") && (
            <ResetCreditExpiry
              provider={provider.id}
              accountId={provider.accountId}
              accountIds={provider.accountIds}
            />
          )}
        </div>
        <Switch
          checked={provider.enabled}
          onChange={() => onToggleProvider(!provider.enabled)}
          label={`${displayName} を${provider.enabled ? "無効化" : "有効化"}`}
          busy={isBusy}
        />
        <ReorderButtons
          label={displayName}
          index={providerIndex}
          count={providerCount}
          busy={isBusy}
          onMove={onMoveProvider}
          className="col-start-2 col-span-2 row-start-2 justify-self-end @xl:col-start-4 @xl:col-span-1 @xl:row-start-1"
        />
      </div>
      {hasModels && expanded && (
        <ul id={panelId} className="space-y-2">
          {visibleModels.map((model) => {
            const modelIndex = provider.models.findIndex((item) => item.id === model.id);
            const modelKey = `${rowKey}::${model.id}`;
            const modelBusy = busyId === modelKey;
            const parentDisabled = !provider.enabled;
            const effortLevels = effortLevelsForModel(model);
            const showEffort =
              effortLevels.length > 0 &&
              (effortLevels.length > 1 || effortLevels[0] !== "off");
            return (
              <li
                key={model.id}
                data-model-row={model.id}
                draggable={!parentDisabled}
                onDragStart={(event) => {
                  event.stopPropagation();
                  event.dataTransfer.effectAllowed = "move";
                  onDragStartModel(model.id);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDropModel(model.id);
                }}
                aria-busy={modelBusy || undefined}
                className={cx(
                  "ml-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-xl border border-border border-l-2 border-l-border bg-surface px-4 py-3 @xl:flex @xl:items-center @xl:gap-3",
                  parentDisabled && "opacity-50",
                  touchTarget?.kind === "model" && touchTarget.rowKey === rowKey && touchTarget.id === model.id && "ring-2 ring-accent",
                )}
              >
                <span
                  data-reorder-model={parentDisabled || modelBusy ? undefined : model.id}
                  aria-hidden="true"
                  className="-m-2 inline-flex h-11 w-8 touch-none items-center justify-center rounded-lg text-muted active:text-accent @xl:h-7 @xl:w-5"
                >
                  <GripVertical className="h-4 w-4 cursor-grab" />
                </span>
                <div className="min-w-0 @xl:flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{model.name}</p>
                    <Badge tone={model.enabled ? "success" : "neutral"}>
                      {model.enabled ? "有効" : "無効"}
                    </Badge>
                  </div>
                </div>
                {showEffort && (
                  <div className="col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted @xl:col-auto @xl:row-auto @xl:shrink-0">
                    <GhostSelect
                      value={model.defaultThinkingLevel ?? ""}
                      disabled={parentDisabled || modelBusy}
                      aria-label={`${model.name} の既定effort`}
                      title="このモデルを選んだ時の既定effort"
                      icon={<Brain className="h-3.5 w-3.5" />}
                      valueLabel={model.defaultThinkingLevel ? THINKING_LEVEL_LABELS[model.defaultThinkingLevel] : "既定"}
                      onChange={(next) =>
                        onDefaultThinkingLevelChange(
                          model.id,
                          isThinkingLevel(next) ? next : null,
                        )
                      }
                      className="max-w-[8rem] shrink-0"
                    >
                      <option value="">既定</option>
                      {effortLevels.map((level) => (
                        <option key={level} value={level}>
                          {THINKING_LEVEL_LABELS[level]}
                        </option>
                      ))}
                    </GhostSelect>
                  </div>
                )}
                <div className="col-start-3 row-start-1 @xl:col-auto @xl:row-auto">
                  <Switch
                    checked={model.enabled}
                    onChange={() => onToggleModel(model.id, !model.enabled)}
                    label={`${displayName} の ${model.name} を${model.enabled ? "無効化" : "有効化"}`}
                    busy={modelBusy || parentDisabled}
                  />
                </div>
                <ReorderButtons
                  label={`${displayName} の ${model.name}`}
                  index={modelIndex}
                  count={provider.models.length}
                  busy={isBusy}
                  onMove={(direction) => onMoveModel(model.id, direction)}
                  className="col-start-3 row-start-2 justify-self-end @xl:col-auto @xl:row-auto"
                />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function ProviderModelsPanel({
  refreshToken = 0,
  onProviderCatalogChange,
}: {
  refreshToken?: number;
  onProviderCatalogChange?: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [providers, setProviders] = useState<ProviderModelsRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const touchDragRef = useRef<{ pointerId: number; source: DragState } | null>(null);
  const [touchTarget, setTouchTarget] = useState<DragState | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [query, setQuery] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const mountedRef = useRef(true);
  const orderQueueRef = useRef(Promise.resolve());
  const orderPendingRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) {
      setStatus("loading");
      setError(null);
    }
    try {
      const data = await getJson<{ providers: ProviderModelsRow[] }>("/api/provider-models");
      if (!mountedRef.current) return;
      setProviders(data.providers);
      setStatus("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof ApiError ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const setDefaultThinkingLevel = useCallback(
    async (
      provider: ProviderModelsRow,
      modelId: string,
      level: ThinkingLevel | null,
    ) => {
      const rowKey = providerRowKey(provider);
      const modelKey = `${rowKey}::${modelId}`;
      setBusyId(modelKey);
      setActionError(null);
      try {
        await sendJson(
          `/api/provider-models/${encodeURIComponent(`${provider.id}::${modelId}`)}`,
          {
            defaultThinkingLevel: level,
            ...(provider.accountId ? { accountId: provider.accountId } : {}),
          },
          "PATCH",
        );
        setProviders((prev) => prev.map((current) =>
          providerRowKey(current) === rowKey
            ? {
                ...current,
                models: current.models.map((model) => {
                  if (model.id !== modelId) return model;
                  if (level === null) {
                    const next = { ...model };
                    delete next.defaultThinkingLevel;
                    return next;
                  }
                  return { ...model, defaultThinkingLevel: level };
                }),
              }
            : current,
        ));
      } catch (err) {
        if (mountedRef.current) setActionError(err instanceof ApiError ? err.message : String(err));
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [],
  );

  const toggle = useCallback(
    async (provider: ProviderModelsRow, modelId: string | undefined, enabled: boolean) => {
      const rowKey = providerRowKey(provider);
      const busyKey = modelId === undefined ? rowKey : `${rowKey}::${modelId}`;
      setBusyId(busyKey);
      setActionError(null);
      setProviders((prev) =>
        prev.map((current) => {
          if (providerRowKey(current) !== rowKey) return current;
          if (modelId === undefined) {
            return {
              ...current,
              enabled,
              models: current.models.map((model) => ({ ...model, enabled: false })),
            };
          }
          return {
            ...current,
            models: current.models.map((model) =>
              model.id === modelId ? { ...model, enabled } : model,
            ),
          };
        }),
      );
      const key = modelId === undefined ? provider.id : `${provider.id}::${modelId}`;
      try {
        await sendJson(
          `/api/provider-models/${encodeURIComponent(key)}`,
          {
            enabled,
            ...(modelId === undefined && enabled
              ? { modelIds: provider.models.map((model) => model.id) }
              : {}),
            ...(provider.accountId ? { accountId: provider.accountId } : {}),
          },
          "PATCH",
        );
        if (modelId === undefined) onProviderCatalogChange?.();
      } catch (err) {
        if (mountedRef.current) {
          setActionError(err instanceof ApiError ? err.message : String(err));
          await load({ quiet: true });
        }
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [load, onProviderCatalogChange],
  );

  const saveOrder = useCallback((nextProviders: ProviderModelsRow[]) => {
    orderPendingRef.current += 1;
    setOrderSaving(true);
    const accountModelOrder: Record<string, Record<string, string[]>> = {};
    for (const provider of nextProviders) {
      if (!provider.accountId) continue;
      const byProvider = (accountModelOrder[provider.accountId] ??= {});
      byProvider[provider.id] = provider.models.map((model) => model.id);
    }
    const operation = orderQueueRef.current.then(async () => {
      if (!mountedRef.current) return;
      setActionError(null);
      try {
        await sendJson(
          "/api/provider-models/order",
          {
            providerOrder: nextProviders.map(providerRowKey),
            modelOrder: Object.fromEntries(
              nextProviders
                .filter((provider) => !provider.accountId)
                .map((provider) => [
                  provider.id,
                  provider.models.map((model) => model.id),
                ]),
            ),
            accountModelOrder,
          },
          "PATCH",
        );
        onProviderCatalogChange?.();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : String(err));
        void load();
      }
    });
    orderQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.finally(() => {
      orderPendingRef.current -= 1;
      if (mountedRef.current && orderPendingRef.current === 0) setOrderSaving(false);
    });
  }, [load, onProviderCatalogChange]);

  // 並び替えは現在の providers を直接参照して次の配列を計算し、setProviders は
  // 確定した値を一度だけ渡す。updater関数内で saveOrder/setReorderAnnouncement を呼ぶと、
  // Strict Modeや並行レンダーでupdaterが再実行された際にPATCHが重複し得るため。
  const moveProvider = useCallback(
    (sourceRowKey: string, targetRowKey: string) => {
      setDragging(null);
      if (sourceRowKey === targetRowKey) return;
      const from = providers.findIndex((provider) => providerRowKey(provider) === sourceRowKey);
      const to = providers.findIndex((provider) => providerRowKey(provider) === targetRowKey);
      if (from < 0 || to < 0) return;
      const next = moveItem(providers, from, to);
      setProviders(next);
      saveOrder(next);
    },
    [providers, saveOrder],
  );

  const moveModel = useCallback(
    (rowKey: string, sourceId: string, targetId: string) => {
      setDragging(null);
      if (sourceId === targetId) {
        return;
      }
      const next = providers.map((provider) => {
        if (providerRowKey(provider) !== rowKey) return provider;
        const from = provider.models.findIndex((model) => model.id === sourceId);
        const to = provider.models.findIndex((model) => model.id === targetId);
        return { ...provider, models: moveItem(provider.models, from, to) };
      });
      setProviders(next);
      saveOrder(next);
    },
    [providers, saveOrder],
  );

  const moveProviderBy = useCallback(
    (rowKey: string, direction: -1 | 1) => {
      const from = providers.findIndex((provider) => providerRowKey(provider) === rowKey);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= providers.length) return;
      const next = moveItem(providers, from, to);
      setProviders(next);
      saveOrder(next);
      setReorderAnnouncement(
        `${providerDisplayName(providers[from]!)}を${to + 1}番目へ移動しました`,
      );
    },
    [providers, saveOrder],
  );

  const moveModelBy = useCallback(
    (rowKey: string, modelId: string, direction: -1 | 1) => {
      let movedLabel = "";
      let movedPosition = 0;
      const next = providers.map((provider) => {
        if (providerRowKey(provider) !== rowKey) return provider;
        const from = provider.models.findIndex((model) => model.id === modelId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= provider.models.length) return provider;
        movedLabel = `${providerDisplayName(provider)} の ${provider.models[from]!.name}`;
        movedPosition = to + 1;
        return { ...provider, models: moveItem(provider.models, from, to) };
      });
      if (!movedLabel) return;
      setProviders(next);
      saveOrder(next);
      setReorderAnnouncement(`${movedLabel}を${movedPosition}番目へ移動しました`);
    },
    [providers, saveOrder],
  );

  const enabledCount = providers.reduce(
    (n, p) => n + p.models.filter((m) => m.enabled).length,
    0,
  );
  const searchTerm = query.trim().toLowerCase();
  const visibleProviders = providers.flatMap((provider, providerIndex) => {
    if (enabledOnly && !provider.enabled) return [];
    const providerMatches = [
      provider.name,
      provider.id,
      provider.accountId,
      provider.accountLabel,
      ...(provider.accountIds ?? []),
    ].some((value) => value?.toLowerCase().includes(searchTerm));
    const matchingModels = provider.models.filter((model) =>
      (!enabledOnly || model.enabled) &&
      (!searchTerm || providerMatches ||
        [model.name, model.id].some((value) => value.toLowerCase().includes(searchTerm))),
    );
    if (searchTerm && !providerMatches && matchingModels.length === 0) return [];
    return [{
      provider,
      providerIndex,
      models: matchingModels,
      searchExpanded: Boolean(searchTerm && !providerMatches),
    }];
  });
  const renderProvider = ({
    provider,
    providerIndex,
    models,
    searchExpanded,
  }: (typeof visibleProviders)[number]) => {
    const rowKey = providerRowKey(provider);
    return (
      <ProviderRow
        key={rowKey}
        provider={provider}
        providerIndex={providerIndex}
        providerCount={providers.length}
        visibleModels={models}
        searchExpanded={searchExpanded}
        busyId={busyId}
        touchTarget={touchTarget}
        onDragStartProvider={() => setDragging({ kind: "provider", rowKey })}
        onDropProvider={() => { if (dragging?.kind === "provider") moveProvider(dragging.rowKey, rowKey); }}
        onDragStartModel={(modelId) => setDragging({ kind: "model", rowKey, id: modelId })}
        onDropModel={(modelId) => { if (dragging?.kind === "model" && dragging.rowKey === rowKey) moveModel(rowKey, dragging.id, modelId); }}
        onMoveProvider={(direction) => moveProviderBy(rowKey, direction)}
        onMoveModel={(modelId, direction) => moveModelBy(rowKey, modelId, direction)}
        onToggleProvider={(enabled) => void toggle(provider, undefined, enabled)}
        onToggleModel={(modelId, enabled) => void toggle(provider, modelId, enabled)}
        onDefaultThinkingLevelChange={(modelId, level) => void setDefaultThinkingLevel(provider, modelId, level)}
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">モデル</h3>
          <p className="text-xs text-muted">
            無効にしたモデルはホームとタスクの選択から外れます。ドラッグまたは上下ボタンで並び替えできます。
            {providers.length > 0 && `（${providers.length} モデル枠・有効 ${enabledCount} モデル）`}
            {orderSaving ? " 並び順を保存中…" : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          再読み込み
        </Button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{reorderAnnouncement}</p>
      {status === "loading" && <p className="text-sm text-muted">読み込み中…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {providers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="block w-full @xl:max-w-sm">
            <span className="sr-only">プロバイダー・モデルを検索</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="プロバイダー・モデルを検索"
              aria-label="プロバイダー・モデルを検索"
              className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            aria-pressed={enabledOnly}
            onClick={() => setEnabledOnly((value) => !value)}
            className={cx(
              "h-10 rounded-lg border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              enabledOnly
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-surface text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            有効化のみ
          </button>
        </div>
      )}
      {status === "ready" && providers.length === 0 && (
        <p className="text-sm text-muted">
          選択可能なプロバイダーまたはログインアカウントがありません。認証設定を確認してください。
        </p>
      )}
      {status === "ready" && (searchTerm || enabledOnly) && providers.length > 0 && visibleProviders.length === 0 && (
        <p className="text-sm text-muted">{searchTerm ? "検索条件に一致する項目はありません。" : "有効なプロバイダーはありません。"}</p>
      )}
      {providers.length > 0 && (
        <ul
          className="space-y-3 select-none"
          // touch-action alone does not block iOS long-press selection/callouts.
          // Limit suppression to reorder rows; search and other settings stay selectable.
          style={{ WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
          onPointerDown={(event) => {
            if (event.pointerType !== "touch" || touchDragRef.current) return;
            const handle = (event.target as Element).closest<HTMLElement>("[data-reorder-provider], [data-reorder-model]");
            if (!handle) return;
            const rowKey = handle.closest("[data-provider-row]")?.getAttribute("data-provider-row");
            if (!rowKey) return;
            const id = handle.getAttribute("data-reorder-model");
            const source: DragState = id
              ? { kind: "model", rowKey, id }
              : { kind: "provider", rowKey };
            event.preventDefault();
            handle.setPointerCapture(event.pointerId);
            touchDragRef.current = { pointerId: event.pointerId, source };
          }}
          onPointerMove={(event) => {
            const drag = touchDragRef.current;
            if (drag?.pointerId !== event.pointerId) return;
            setTouchTarget(touchDropTarget(drag.source, event.clientX, event.clientY));
          }}
          onPointerUp={(event) => {
            const drag = touchDragRef.current;
            if (drag?.pointerId !== event.pointerId) return;
            const target = touchDropTarget(drag.source, event.clientX, event.clientY);
            touchDragRef.current = null;
            setTouchTarget(null);
            if (!target || drag.source.kind !== target.kind) return;
            if (drag.source.kind === "provider" && target.kind === "provider") {
              moveProvider(drag.source.rowKey, target.rowKey);
            } else if (drag.source.kind === "model" && target.kind === "model") {
              moveModel(drag.source.rowKey, drag.source.id, target.id);
            }
          }}
          onPointerCancel={() => { touchDragRef.current = null; setTouchTarget(null); }}
          onLostPointerCapture={() => { touchDragRef.current = null; setTouchTarget(null); }}
        >
          {visibleProviders.map(renderProvider)}
        </ul>
      )}
    </div>
  );
}

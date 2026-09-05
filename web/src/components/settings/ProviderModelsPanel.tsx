"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { Badge, Button, Switch, cx } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ApiError, getJson, sendJson } from "@/lib/client";
import type { ProviderModelsRow } from "@/lib/provider-models";

type DragState =
  | { kind: "provider"; rowKey: string }
  | { kind: "model"; rowKey: string; id: string };

function providerRowKey(provider: ProviderModelsRow): string {
  return provider.accountId ? `${provider.accountId}::${provider.id}` : provider.id;
}

function providerDisplayName(provider: ProviderModelsRow): string {
  return provider.accountLabel
    ? `${provider.name} · ${provider.accountLabel}`
    : provider.name;
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return items;
  next.splice(to, 0, item);
  return next;
}

function ReorderButtons({
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
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 sm:h-7 sm:w-7"
      >
        <ChevronUp aria-hidden="true" className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={`${label} を下へ`}
        title="下へ"
        disabled={busy || index >= count - 1}
        onClick={() => onMove(1)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 sm:h-7 sm:w-7"
      >
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

function ProviderRow({
  provider,
  providerIndex,
  providerCount,
  busyId,
  onToggleProvider,
  onToggleModel,
  onContextWindowChange,
  onMoveProvider,
  onMoveModel,
  onDragStartProvider,
  onDropProvider,
  onDragStartModel,
  onDropModel,
}: {
  provider: ProviderModelsRow;
  providerIndex: number;
  providerCount: number;
  busyId: string | null;
  onToggleProvider: (enabled: boolean) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onContextWindowChange: (modelId: string, contextWindow: number) => void;
  onMoveProvider: (direction: -1 | 1) => void;
  onMoveModel: (modelId: string, direction: -1 | 1) => void;
  onDragStartProvider: () => void;
  onDropProvider: () => void;
  onDragStartModel: (modelId: string) => void;
  onDropModel: (modelId: string) => void;
}) {
  // 既定は折りたたみ。プロバイダーが増えると全展開では一覧が長くなるため。
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const rowKey = providerRowKey(provider);
  const displayName = providerDisplayName(provider);
  const isBusy = busyId === rowKey || busyId?.startsWith(`${rowKey}::`) === true;
  const hasModels = provider.models.length > 0;

  return (
    <li
      aria-busy={isBusy || undefined}
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
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        <div className="flex items-center gap-1">
          <GripVertical
            aria-hidden="true"
            className="h-4 w-4 shrink-0 cursor-grab text-muted"
          />
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
            <span className="font-mono text-xs text-muted">{provider.id}</span>
            {provider.accountLabel && (
              <span className="text-xs text-muted">アカウント: {provider.accountLabel}</span>
            )}
            <Badge tone={provider.enabled ? "success" : "neutral"}>
              {provider.enabled ? "有効" : "無効"}
            </Badge>
          </div>
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
          className="col-start-2 col-span-2 row-start-2 justify-self-end sm:col-start-4 sm:col-span-1 sm:row-start-1"
        />
      </div>
      {hasModels && expanded && (
        <ul id={panelId} className="space-y-2">
          {provider.models.map((model, modelIndex) => {
            const modelKey = `${rowKey}::${model.id}`;
            const modelBusy = busyId === modelKey;
            const parentDisabled = !provider.enabled;
            return (
              <li
                key={model.id}
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
                  "ml-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-xl border border-border border-l-2 border-l-border bg-surface px-4 py-3 sm:flex sm:items-center sm:gap-3",
                  parentDisabled && "opacity-50",
                )}
              >
                <GripVertical
                  aria-hidden="true"
                  className="mt-1 h-4 w-4 shrink-0 cursor-grab text-muted sm:mt-0"
                />
                <div className="min-w-0 sm:flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{model.name}</p>
                    <Badge tone={model.enabled ? "success" : "neutral"}>
                      {model.enabled ? "有効" : "無効"}
                    </Badge>
                  </div>
                </div>
                <label className="col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted sm:col-auto sm:row-auto sm:shrink-0 sm:flex-nowrap">
                  <span className="sr-only">{model.name} のコンテキストサイズ</span>
                  <input
                    type="number"
                    min={4096}
                    max={1_000_000}
                    step={1024}
                    defaultValue={model.contextWindow}
                    placeholder="既定"
                    disabled={parentDisabled || modelBusy}
                    onBlur={(event) => {
                      const value = Number(event.currentTarget.value);
                      if (Number.isSafeInteger(value) && value >= 4096 && value <= 1_000_000) {
                        onContextWindowChange(model.id, value);
                      }
                    }}
                    className="w-28 max-w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-right text-xs text-text"
                    aria-label={`${model.name} のコンテキストサイズ`}
                  />
                  <span className="shrink-0">tokens</span>
                </label>
                <div className="col-start-3 row-start-1 sm:col-auto sm:row-auto">
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
                  className="col-start-3 row-start-2 justify-self-end sm:col-auto sm:row-auto"
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
}: {
  refreshToken?: number;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [providers, setProviders] = useState<ProviderModelsRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
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

  const setContextWindow = useCallback(
    async (provider: ProviderModelsRow, modelId: string, contextWindow: number) => {
      const rowKey = providerRowKey(provider);
      const modelKey = `${rowKey}::${modelId}`;
      setBusyId(modelKey);
      setActionError(null);
      try {
        await sendJson(
          `/api/provider-models/${encodeURIComponent(`${provider.id}::${modelId}`)}`,
          { contextWindow, ...(provider.accountId ? { accountId: provider.accountId } : {}) },
          "PATCH",
        );
        setProviders((prev) => prev.map((current) =>
          providerRowKey(current) === rowKey
            ? { ...current, models: current.models.map((model) => model.id === modelId ? { ...model, contextWindow } : model) }
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
      } catch (err) {
        if (mountedRef.current) {
          setActionError(err instanceof ApiError ? err.message : String(err));
          await load({ quiet: true });
        }
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [load],
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
  }, [load]);

  // 並び替えは現在の providers を直接参照して次の配列を計算し、setProviders は
  // 確定した値を一度だけ渡す。updater関数内で saveOrder/setReorderAnnouncement を呼ぶと、
  // Strict Modeや並行レンダーでupdaterが再実行された際にPATCHが重複し得るため。
  const moveProvider = useCallback(
    (targetRowKey: string) => {
      setDragging(null);
      if (dragging?.kind !== "provider" || dragging.rowKey === targetRowKey) return;
      const from = providers.findIndex((provider) => providerRowKey(provider) === dragging.rowKey);
      const to = providers.findIndex((provider) => providerRowKey(provider) === targetRowKey);
      if (from < 0 || to < 0) return;
      const next = moveItem(providers, from, to);
      setProviders(next);
      saveOrder(next);
    },
    [dragging, providers, saveOrder],
  );

  const moveModel = useCallback(
    (rowKey: string, targetId: string) => {
      setDragging(null);
      if (
        dragging?.kind !== "model" ||
        dragging.rowKey !== rowKey ||
        dragging.id === targetId
      ) {
        return;
      }
      const next = providers.map((provider) => {
        if (providerRowKey(provider) !== rowKey) return provider;
        const from = provider.models.findIndex((model) => model.id === dragging.id);
        const to = provider.models.findIndex((model) => model.id === targetId);
        return { ...provider, models: moveItem(provider.models, from, to) };
      });
      setProviders(next);
      saveOrder(next);
    },
    [dragging, providers, saveOrder],
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
  const renderProvider = (provider: ProviderModelsRow, providerIndex: number) => {
    const rowKey = providerRowKey(provider);
    return (
      <ProviderRow
        key={rowKey}
        provider={provider}
        providerIndex={providerIndex}
        providerCount={providers.length}
        busyId={busyId}
        onDragStartProvider={() => setDragging({ kind: "provider", rowKey })}
        onDropProvider={() => moveProvider(rowKey)}
        onDragStartModel={(modelId) => setDragging({ kind: "model", rowKey, id: modelId })}
        onDropModel={(modelId) => moveModel(rowKey, modelId)}
        onMoveProvider={(direction) => moveProviderBy(rowKey, direction)}
        onMoveModel={(modelId, direction) => moveModelBy(rowKey, modelId, direction)}
        onToggleProvider={(enabled) => void toggle(provider, undefined, enabled)}
        onToggleModel={(modelId, enabled) => void toggle(provider, modelId, enabled)}
        onContextWindowChange={(modelId, contextWindow) => void setContextWindow(provider, modelId, contextWindow)}
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
      {status === "ready" && providers.length === 0 && (
        <p className="text-sm text-muted">
          選択可能なプロバイダーまたはログインアカウントがありません。認証設定を確認してください。
        </p>
      )}
      {providers.length > 0 && <ul className="space-y-3">{providers.map(renderProvider)}</ul>}
    </div>
  );
}

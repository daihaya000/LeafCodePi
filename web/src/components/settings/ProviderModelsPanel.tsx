"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { Badge, Button, cx } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ApiError, getJson, sendJson } from "@/lib/client";
import type { ProviderModelsRow } from "@/lib/provider-models";

type DragState =
  | { kind: "provider"; id: string }
  | { kind: "model"; providerId: string; id: string };

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function ExtensionSwitch({
  name,
  enabled,
  busy,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${name} を${enabled ? "無効化" : "有効化"}`}
      disabled={busy}
      onClick={onToggle}
      className={cx(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        enabled ? "bg-primary" : "bg-surface-3",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform",
          enabled ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

function ProviderRow({
  provider,
  busyId,
  onToggleProvider,
  onToggleModel,
  onDragStartProvider,
  onDropProvider,
  onDragStartModel,
  onDropModel,
}: {
  provider: ProviderModelsRow;
  busyId: string | null;
  onToggleProvider: (enabled: boolean) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onDragStartProvider: () => void;
  onDropProvider: () => void;
  onDragStartModel: (modelId: string) => void;
  onDropModel: (modelId: string) => void;
}) {
  // 既定は折りたたみ。プロバイダーが増えると全展開では一覧が長くなるため。
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const isBusy = busyId === provider.id;
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
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <GripVertical
          aria-label={`${provider.name} をドラッグして並び替え`}
          className="h-4 w-4 shrink-0 cursor-grab text-muted"
        />
        {hasModels && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={`${provider.name} のモデルを${expanded ? "折りたたむ" : "展開"}`}
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon providerID={provider.id} size={16} />
            <p className="min-w-0 truncate text-sm font-medium">{provider.name}</p>
            <span className="font-mono text-xs text-muted">{provider.id}</span>
            <Badge tone={provider.enabled ? "success" : "neutral"}>
              {provider.enabled ? "有効" : "無効"}
            </Badge>
          </div>
        </div>
        <ExtensionSwitch
          name={provider.name}
          enabled={provider.enabled}
          busy={isBusy}
          onToggle={() => onToggleProvider(!provider.enabled)}
        />
      </div>
      {hasModels && expanded && (
        <ul id={panelId} className="space-y-2">
          {provider.models.map((model) => {
            const modelKey = `${provider.id}::${model.id}`;
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
                  "ml-4 flex items-center gap-3 rounded-xl border border-border border-l-2 border-l-border bg-surface px-4 py-3",
                  parentDisabled && "opacity-50",
                )}
              >
                <GripVertical
                  aria-label={`${model.name} をドラッグして並び替え`}
                  className="h-4 w-4 shrink-0 cursor-grab text-muted"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{model.name}</p>
                    <Badge tone={model.enabled ? "success" : "neutral"}>
                      {model.enabled ? "有効" : "無効"}
                    </Badge>
                  </div>
                </div>
                <ExtensionSwitch
                  name={model.name}
                  enabled={model.enabled}
                  busy={modelBusy || parentDisabled}
                  onToggle={() => onToggleModel(model.id, !model.enabled)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function ProviderModelsPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [providers, setProviders] = useState<ProviderModelsRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
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
  }, [load]);

  const toggle = useCallback(
    async (key: string, enabled: boolean) => {
      setBusyId(key);
      setActionError(null);
      setProviders((prev) =>
        prev.map((provider) => {
          if (provider.id === key) {
            return {
              ...provider,
              enabled,
              models: provider.models.map((model) => ({ ...model, enabled })),
            };
          }
          if (!key.startsWith(`${provider.id}::`)) return provider;
          const modelId = key.slice(provider.id.length + 2);
          return {
            ...provider,
            models: provider.models.map((model) =>
              model.id === modelId ? { ...model, enabled } : model,
            ),
          };
        }),
      );
      try {
        await sendJson(`/api/provider-models/${encodeURIComponent(key)}`, { enabled }, "PATCH");
        if (!mountedRef.current) return;
        await load({ quiet: true });
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
    const operation = orderQueueRef.current.then(async () => {
      if (!mountedRef.current) return;
      setActionError(null);
      try {
        await sendJson(
          "/api/provider-models/order",
          {
            providerOrder: nextProviders.map((provider) => provider.id),
            modelOrder: Object.fromEntries(
              nextProviders.map((provider) => [
                provider.id,
                provider.models.map((model) => model.id),
              ]),
            ),
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

  const moveProvider = useCallback(
    (targetId: string) => {
      if (dragging?.kind !== "provider" || dragging.id === targetId) return;
      setProviders((prev) => {
        const from = prev.findIndex((provider) => provider.id === dragging.id);
        const to = prev.findIndex((provider) => provider.id === targetId);
        const next = moveItem(prev, from, to);
        saveOrder(next);
        return next;
      });
      setDragging(null);
    },
    [dragging, saveOrder],
  );

  const moveModel = useCallback(
    (providerId: string, targetId: string) => {
      if (
        dragging?.kind !== "model" ||
        dragging.providerId !== providerId ||
        dragging.id === targetId
      ) {
        return;
      }
      setProviders((prev) => {
        const next = prev.map((provider) => {
          if (provider.id !== providerId) return provider;
          const from = provider.models.findIndex((model) => model.id === dragging.id);
          const to = provider.models.findIndex((model) => model.id === targetId);
          return { ...provider, models: moveItem(provider.models, from, to) };
        });
        saveOrder(next);
        return next;
      });
      setDragging(null);
    },
    [dragging, saveOrder],
  );

  const enabledCount = providers.reduce(
    (n, p) => n + p.models.filter((m) => m.enabled).length,
    0,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="mb-1 text-sm font-semibold">モデルの有効化と並び替え</h2>
          <p className="text-xs text-muted">
            無効にしたモデルはホームとタスクの選択から外れます。ドラッグで並び替えできます。
            {providers.length > 0 &&
              `（${providers.length} プロバイダー・有効 ${enabledCount} モデル）`}
            {orderSaving ? " 並び順を保存中…" : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          再読み込み
        </Button>
      </div>
      {status === "loading" && <p className="text-sm text-muted">読み込み中…</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {actionError && <p className="text-sm text-danger">{actionError}</p>}
      {status === "ready" && providers.length === 0 && (
        <p className="text-sm text-muted">
          認証済みプロバイダーがありません。エンジンタブでサブスクまたは API キーを設定してください。
        </p>
      )}
      {providers.length > 0 && (
        <ul className="space-y-3">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              busyId={busyId}
              onDragStartProvider={() => setDragging({ kind: "provider", id: provider.id })}
              onDropProvider={() => moveProvider(provider.id)}
              onDragStartModel={(modelId) =>
                setDragging({ kind: "model", providerId: provider.id, id: modelId })
              }
              onDropModel={(modelId) => moveModel(provider.id, modelId)}
              onToggleProvider={(enabled) => void toggle(provider.id, enabled)}
              onToggleModel={(modelId, enabled) =>
                void toggle(`${provider.id}::${modelId}`, enabled)
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  LayoutList,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { cx, timeAgo } from "@/components/ui";
import { useCodexUsage } from "@/components/codexbar/use-codex-usage";
import {
  useCodexProviders,
  type ConfigProvider,
} from "@/components/codexbar/use-codex-providers";
import {
  clampPercent,
  formatMonthlyTotal,
  formatPlanBadge,
  formatResetsIn,
  hasLastGoodUsage,
  isStale,
  limitedCount,
  overallUsedPercent,
  percentTone,
  providerIconSrc,
  providerIconSrcForOpencodeId,
  providerLabel,
  usageTone,
  worstProvider,
  type CodexBarCredits,
  type CodexBarProvider,
  type UsageTone,
} from "@/lib/codexbar";

const COLLAPSED_KEY = "webui:codexbar:collapsed";
const PROVIDERS_KEY = "webui:codexbar:providers";
const LAYOUT_KEY = "webui:codexbar:layout";

const barClass: Record<UsageTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  danger: "bg-danger",
};
const textClass: Record<UsageTone, string> = {
  ok: "text-muted",
  warn: "text-warning",
  danger: "text-danger",
};

function loadCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSED_KEY);
    return saved === null ? true : saved === "1";
  } catch {
    return true;
  }
}
function saveCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function loadTwoColumn(): boolean {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved === null ? true : saved === "2";
  } catch {
    return true;
  }
}
function saveTwoColumn(v: boolean) {
  try {
    localStorage.setItem(LAYOUT_KEY, v ? "2" : "1");
  } catch {
    /* ignore */
  }
}

function loadProviderCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === true) out[k] = true;
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}
function saveProviderCollapsed(map: Record<string, boolean>) {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function OverallRow({
  percent,
  subscriptionTotalMonthlyUsd,
}: {
  percent: number;
  subscriptionTotalMonthlyUsd: number | null;
}) {
  const tone = percentTone(percent);
  return (
    <div className="mb-2.5 border-b border-border pb-2.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-text">全体</span>
        {subscriptionTotalMonthlyUsd !== null && subscriptionTotalMonthlyUsd > 0 && (
          <span
            className="shrink-0 rounded border border-border bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-muted"
            title="サブスク合計（公開定価の概算）"
          >
            {formatMonthlyTotal(subscriptionTotalMonthlyUsd)}
          </span>
        )}
        <span className={cx("ml-auto font-mono", textClass[tone])}>
          {Math.round(percent)}%
        </span>
      </div>
      <UsageBar tone={tone} percent={percent} />
    </div>
  );
}

function ProviderIcon({ p, tone }: { p: CodexBarProvider; tone: UsageTone }) {
  const [broken, setBroken] = useState(false);
  const src =
    providerIconSrc(p.id) ??
    (p.opencodeId ? providerIconSrcForOpencodeId(p.opencodeId) : null);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
        onError={() => setBroken(true)}
      />
    );
  }
  return <Activity className={cx("h-4 w-4 shrink-0", textClass[tone])} />;
}

function SettingsProviderIcon({ id }: { id: string }) {
  const [broken, setBroken] = useState(false);
  const src = providerIconSrc(id);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
        onError={() => setBroken(true)}
      />
    );
  }
  return <Activity className="h-4 w-4 shrink-0 text-muted" />;
}

function ProviderSettingsRow({
  provider,
  saving,
  isLastEnabled,
  onToggle,
}: {
  provider: ConfigProvider;
  saving: boolean;
  isLastEnabled: boolean;
  onToggle: () => void;
}) {
  const disabled =
    saving || !provider.configurable || (provider.enabled && isLastEnabled);
  return (
    <li className="flex items-center gap-2 border-b border-border py-2 last:border-b-0">
      <SettingsProviderIcon id={provider.id} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
        {provider.name}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={provider.enabled}
        aria-label={`${provider.name} を CodexBar で更新`}
        disabled={disabled}
        onClick={onToggle}
        className={cx(
          "inline-flex h-6 min-w-11 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          provider.enabled ? "bg-success" : "bg-surface-3",
        )}
      >
        <span
          className={cx(
            "h-5 w-5 rounded-full bg-surface shadow-sm transition-transform",
            provider.enabled && "translate-x-5",
          )}
        />
        <span className="sr-only">CodexBarで更新</span>
      </button>
      <span className="w-12 shrink-0 text-right text-[10px] text-faint">
        {saving ? "保存中…" : provider.enabled ? "オン" : "オフ"}
      </span>
    </li>
  );
}

function UsageBar({ tone, percent }: { tone: UsageTone; percent: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={cx("h-full rounded-full transition-all", barClass[tone])}
        style={{ width: `${clampPercent(percent)}%` }}
      />
    </div>
  );
}

function WindowRow({
  title,
  percent,
  resetsAt,
  now,
}: {
  title: string;
  percent: number | null;
  resetsAt: string | null;
  now: number;
}) {
  const tone = percentTone(percent);
  const resets = formatResetsIn(resetsAt, now);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted">{title}</span>
        <span className={cx("shrink-0 font-mono", textClass[tone])}>
          {percent === null ? "—" : `${Math.round(percent)}%`}
        </span>
      </div>
      <UsageBar tone={tone} percent={percent} />
      {resets && (
        <div className="text-right text-[10px] text-faint">リセット {resets}</div>
      )}
    </div>
  );
}

function formatCreditAmount(value: number): string {
  return `$${value.toFixed(2)}`;
}

function CreditsRow({ credits }: { credits: CodexBarCredits }) {
  const percent =
    credits.used !== null && credits.limit !== null && credits.limit > 0
      ? (credits.used / credits.limit) * 100
      : null;
  const tone = percentTone(percent);
  const amount =
    credits.used !== null && credits.limit !== null
      ? `${formatCreditAmount(credits.used)} / ${formatCreditAmount(credits.limit)}`
      : credits.used !== null
        ? formatCreditAmount(credits.used)
        : credits.limit !== null
          ? `上限 ${formatCreditAmount(credits.limit)}`
          : null;

  return (
    <div className="flex flex-col gap-0.5 border-t border-border pt-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted">{credits.title ?? "利用クレジット"}</span>
        {amount && <span className="shrink-0 font-mono text-text">{amount}</span>}
      </div>
      {percent !== null && (
        <>
          <UsageBar tone={tone} percent={percent} />
          <div className={cx("text-right text-[10px] font-mono", textClass[tone])}>
            {Math.round(percent)}%
          </div>
        </>
      )}
      {credits.balance !== null && (
        <div className="text-right text-[10px] text-faint">
          残高 {formatCreditAmount(credits.balance)}
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  p,
  now,
  collapsed,
  onToggle,
  compact,
}: {
  p: CodexBarProvider;
  now: number;
  collapsed: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  const tone = usageTone(p);
  const resets = formatResetsIn(p.resetsAt, now);
  const hasWindows = p.windows.length > 0;
  const showErrorOnly = !!p.error && !hasLastGoodUsage(p);
  const canExpand = showErrorOnly || hasLastGoodUsage(p);
  const label = providerLabel(p.id);
  const planBadge = formatPlanBadge(p.plan, p.planMonthlyUsd);

  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-2/40 p-2">
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        aria-expanded={canExpand ? !collapsed : undefined}
        aria-label={canExpand ? `${label} を${collapsed ? "展開" : "最小化"}` : undefined}
        className={cx(
          "flex w-full items-center gap-2 text-xs",
          canExpand && "cursor-pointer rounded-md -mx-1 px-1 py-0.5 hover:bg-surface-3",
        )}
      >
        <ProviderIcon p={p} tone={showErrorOnly ? "danger" : tone} />
        <span className="min-w-0 flex-1 truncate font-semibold text-text">{label}</span>
        {!compact && planBadge && (
          <span
            className="max-w-28 shrink truncate rounded border border-border bg-surface-3 px-1 text-[10px] font-medium text-muted"
            title={`プラン: ${planBadge}`}
          >
            {planBadge}
          </span>
        )}
        {showErrorOnly ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-danger">
            <AlertTriangle className="h-3 w-3" /> エラー
          </span>
        ) : (
          <span className={cx("ml-auto shrink-0 font-mono", textClass[tone])}>
            {p.usedPercent === null ? "—" : `${Math.round(p.usedPercent)}%`}
          </span>
        )}
        {canExpand &&
          (collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
          ))}
      </button>

      {collapsed ? (
        showErrorOnly ? null : (
          <div className="pl-6">
            <UsageBar tone={tone} percent={p.usedPercent} />
          </div>
        )
      ) : showErrorOnly ? (
        <p className="pl-6 text-[10px] text-faint">{p.error}</p>
      ) : canExpand ? (
        <div className="flex flex-col gap-1.5 pl-6">
          {p.windows.map((w) => (
            <WindowRow
              key={w.id || w.title}
              title={w.title || "—"}
              percent={w.usedPercent}
              resetsAt={w.resetsAt}
              now={now}
            />
          ))}
          {!hasWindows && p.usedPercent !== null && (
            <div>
              <UsageBar tone={tone} percent={p.usedPercent} />
              {resets && (
                <div className="text-right text-[10px] text-faint">リセット {resets}</div>
              )}
            </div>
          )}
          {p.credits && <CreditsRow credits={p.credits} />}
        </div>
      ) : (
        <div className="pl-6">
          <UsageBar tone={tone} percent={p.usedPercent} />
        </div>
      )}
    </li>
  );
}

export function CodexBarWidget({
  initialCollapsed,
}: {
  initialCollapsed?: boolean;
} = {}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed ?? true);
  const { usage, loadError, refreshing, refresh, now } = useCodexUsage({
    // Collapsed chip keeps last snapshot; avoid provider API churn while chatting.
    enabled: !collapsed,
  });
  const [twoColumn, setTwoColumn] = useState(true);
  const [providerCollapsed, setProviderCollapsed] = useState<Record<string, boolean>>({});
  const {
    settingsOpen,
    providerSettings,
    settingsLoading,
    settingsError,
    settingsStatus,
    savingProviderId,
    toggleProviderSettings,
    toggleProviderEnabled,
    loadProviderSettings,
  } = useCodexProviders({ refresh });

  useEffect(() => {
    if (!usage || usage.providers.length === 0) return;
    setProviderCollapsed((prev) => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(PROVIDERS_KEY);
      } catch {
        /* ignore */
      }
      if (saved !== null) return prev;

      const next = { ...prev };
      for (const provider of usage.providers) next[provider.id] = true;
      saveProviderCollapsed(next);
      return next;
    });
  }, [usage]);

  useEffect(() => {
    setCollapsed(initialCollapsed ?? loadCollapsed());
    setTwoColumn(loadTwoColumn());
    setProviderCollapsed(loadProviderCollapsed());
  }, [initialCollapsed]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      saveCollapsed(next);
      return next;
    });
  };

  const toggleTwoColumn = () => {
    setTwoColumn((v) => {
      const next = !v;
      saveTwoColumn(next);
      return next;
    });
  };

  const toggleProvider = useCallback((id: string) => {
    setProviderCollapsed((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      saveProviderCollapsed(next);
      return next;
    });
  }, []);

  const worst = usage ? worstProvider(usage) : null;
  const summaryTone: UsageTone = worst ? usageTone(worst) : "ok";
  const overall = usage ? overallUsedPercent(usage) : null;
  const limited = usage ? limitedCount(usage) : 0;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label="CodexBar 利用状況を開く"
        title="CodexBar 利用状況を開く"
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-xs hover:bg-surface-2"
      >
        <Activity className={cx("h-3.5 w-3.5", textClass[summaryTone])} />
        <span className="font-medium text-text">CodexBar</span>
        {overall !== null && (
          <span className="font-mono text-muted">全体 {Math.round(overall)}%</span>
        )}
        {limited > 0 && (
          <span className="rounded-full bg-danger-bg px-1.5 font-mono text-danger">
            {limited} 制限
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col rounded-xl border border-border bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <Activity className={cx("h-4 w-4", textClass[summaryTone])} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">
          CodexBar 利用状況
        </span>
        {usage?.available && usage.generatedAt && (
          <span
            className={cx(
              "max-w-20 shrink-0 truncate text-[10px]",
              isStale(usage.generatedAt, now) ? "text-warning" : "text-faint",
            )}
            title={
              isStale(usage.generatedAt, now)
                ? "古い可能性（CodexBar 停止中?）"
                : "最終更新"
            }
          >
            更新 {timeAgo(usage.generatedAt)}
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label={refreshing ? "更新中" : "更新"}
          aria-busy={refreshing}
          title={refreshing ? "更新中" : "更新"}
          className="h-6 w-6 rounded-md p-1 text-faint hover:bg-surface-2 hover:text-text"
        >
          <RefreshCw className={cx("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={toggleProviderSettings}
          aria-expanded={settingsOpen}
          aria-controls="codexbar-provider-settings"
          aria-label="更新するプロバイダー"
          title="更新するプロバイダー"
          className={cx(
            "h-6 w-6 rounded-md p-1 hover:bg-surface-2 hover:text-text",
            settingsOpen ? "bg-surface-2 text-text" : "text-faint",
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={toggleTwoColumn}
          aria-pressed={twoColumn}
          aria-label={twoColumn ? "1列表示にする" : "2列表示にする"}
          title={twoColumn ? "1列表示にする" : "2列表示にする（高さを抑える）"}
          className={cx(
            "h-6 w-6 rounded-md p-1 hover:bg-surface-2 hover:text-text",
            twoColumn ? "bg-surface-2 text-text" : "text-faint",
          )}
        >
          {twoColumn ? (
            <LayoutList className="h-3.5 w-3.5" />
          ) : (
            <LayoutGrid className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          title="折りたたむ"
          aria-label="折りたたむ"
          className="h-6 w-6 rounded-md p-1 text-faint hover:bg-surface-2 hover:text-text"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </div>

      {settingsOpen && (
        <section
          id="codexbar-provider-settings"
          aria-label="更新するプロバイダー"
          aria-busy={settingsLoading || savingProviderId !== null}
          className="shrink-0 border-b border-border px-3 py-2"
        >
          <p className="mb-1 min-w-0 text-[10px] font-medium text-muted">
            更新するプロバイダー
          </p>
          <div role="status" aria-live="polite" className="sr-only">
            {settingsLoading
              ? "読み込み中…"
              : savingProviderId !== null
                ? "保存中…"
                : settingsStatus}
          </div>
          {settingsLoading && (
            <p className="text-[11px] text-muted">読み込み中…</p>
          )}
          {settingsError && (
            <div
              role="alert"
              className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-danger"
            >
              <span className="min-w-0 flex-1">{settingsError}</span>
              <button
                type="button"
                onClick={() => void loadProviderSettings()}
                className="h-6 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium hover:bg-danger-bg"
              >
                再試行
              </button>
            </div>
          )}
          {providerSettings && (
            <ul>
              {providerSettings.providers.map((provider) => (
                <ProviderSettingsRow
                  key={provider.id}
                  provider={provider}
                  saving={savingProviderId === provider.id}
                  isLastEnabled={
                    provider.enabled &&
                    providerSettings.providers.filter((item) => item.enabled)
                      .length === 1
                  }
                  onToggle={() => void toggleProviderEnabled(provider)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="min-h-0 px-3 py-2.5">
        {usage?.available && overall !== null && (
          <OverallRow
            percent={overall}
            subscriptionTotalMonthlyUsd={usage.subscriptionTotalMonthlyUsd}
          />
        )}
        {loadError && (
          <p role="alert" className="text-[11px] text-danger">
            読み込みエラー: {loadError}
          </p>
        )}
        {!loadError && !usage && <p className="text-[11px] text-faint">読み込み中…</p>}
        {!loadError && usage && !usage.available && (
          <p className="text-[11px] text-faint">{usage.reason ?? "利用できません"}</p>
        )}
        {!loadError && usage && usage.available && usage.providers.length === 0 && (
          <p className="text-[11px] text-faint">プロバイダー情報がありません</p>
        )}
        {!loadError && usage && usage.available && usage.providers.length > 0 && (
          <ul
            className={cx(
              twoColumn ? "grid grid-cols-2 items-start gap-2" : "space-y-2.5",
            )}
          >
            {usage.providers.map((p) => (
              <ProviderRow
                key={p.id}
                p={p}
                now={now}
                collapsed={!!providerCollapsed[p.id]}
                onToggle={() => toggleProvider(p.id)}
                compact={twoColumn}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

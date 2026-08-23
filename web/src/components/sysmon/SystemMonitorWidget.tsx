"use client";

import { Fragment, useEffect, useState } from "react";
import {
  ChevronUp,
  Cpu,
  LayoutGrid,
  LayoutList,
  MemoryStick,
  Monitor,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { cx } from "@/components/ui";
import { useSystemMonitor, SYSMON_POLL_ACTIVE_MS, SYSMON_POLL_COLLAPSED_MS } from "@/components/sysmon/use-system-monitor";
import {
  clampPercent,
  formatBytes,
  percentTone,
  type GpuMetric,
  type MemoryMetric,
  type SystemUsage,
  type Tone,
} from "@/lib/sysmon";

const COLLAPSED_KEY = "webui:sysmon:collapsed";
const LAYOUT_KEY = "webui:sysmon:layout";
const HIDDEN_KEY = "webui:sysmon:hidden";

const barClass: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  danger: "bg-danger",
};
const textClass: Record<Tone, string> = {
  ok: "text-muted",
  warn: "text-warning",
  danger: "text-danger",
};

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
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

function loadHiddenItems(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((s): s is string => typeof s === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}
function saveHiddenItems(items: Set<string>) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...items]));
  } catch {
    /* ignore */
  }
}

function UsageBar({ tone, percent }: { tone: Tone; percent: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={cx("h-full rounded-full transition-all", barClass[tone])}
        style={{ width: `${clampPercent(percent)}%` }}
      />
    </div>
  );
}

function MetricRow({
  icon,
  label,
  percent,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  percent: number | null;
  detail?: string;
}) {
  const tone = percentTone(percent);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="shrink-0 text-faint">{icon}</span>
        <span className="truncate text-muted">{label}</span>
        <span className={cx("ml-auto shrink-0 font-mono", textClass[tone])} title={detail}>
          {percent === null ? "—" : `${Math.round(percent)}%`}
        </span>
      </div>
      <UsageBar tone={tone} percent={percent} />
      {detail && <div className="text-right text-[10px] text-faint">{detail}</div>}
    </div>
  );
}

function memoryDetail(memory: MemoryMetric): string {
  return `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`;
}

function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-[11px] hover:bg-surface-2"
      >
        <span className="min-w-0 truncate text-muted">{label}</span>
        <span
          className={cx(
            "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
            checked ? "bg-success" : "bg-surface-3",
          )}
          aria-hidden="true"
        >
          <span
            className={cx(
              "h-3 w-3 rounded-full bg-surface shadow-sm transition-transform",
              checked && "translate-x-3",
            )}
          />
        </span>
      </button>
    </li>
  );
}

function gpuDetail(gpu: GpuMetric): string {
  if (!gpu.available) return gpu.reason ?? "利用不可";
  if (gpu.vramTotalBytes === null || gpu.vramTotalBytes <= 0) return gpu.name ?? "GPU";
  return `${formatBytes(gpu.vramUsedBytes)} / ${formatBytes(gpu.vramTotalBytes)}`;
}

function gpuTempDetail(gpu: GpuMetric): string | undefined {
  if (gpu.tempC === null || gpu.tempC === undefined) return undefined;
  const cur = `${Math.round(gpu.tempC)}°C`;
  if (gpu.tempMaxC === null || gpu.tempMaxC === undefined || gpu.tempMaxC <= 0) return cur;
  return `${cur} / ${Math.round(gpu.tempMaxC)}°C`;
}

function summaryPercent(usage: SystemUsage): number | null {
  if (!usage.available) return null;
  const values: number[] = [];
  if (usage.cpu?.usedPercent !== null && usage.cpu?.usedPercent !== undefined) {
    values.push(usage.cpu.usedPercent);
  }
  if (usage.memory) values.push(usage.memory.usedPercent);
  for (const gpu of usage.gpus) {
    if (gpu.available && gpu.usedPercent !== null) values.push(gpu.usedPercent);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function MetricRows({
  usage,
  twoColumn,
  hidden,
}: {
  usage: SystemUsage;
  twoColumn: boolean;
  hidden: Set<string>;
}) {
  return (
    <div className={cx(twoColumn ? "grid grid-cols-2 items-start gap-2" : "flex flex-col gap-2")}>
      {!hidden.has("cpu") && (
        <MetricRow
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="CPU"
          percent={usage.cpu?.usedPercent ?? null}
          detail={usage.cpu ? `${usage.cpu.cores} コア` : "—"}
        />
      )}
      {!hidden.has("ram") && (
        <MetricRow
          icon={<MemoryStick className="h-3.5 w-3.5" />}
          label="RAM"
          percent={usage.memory ? usage.memory.usedPercent : null}
          detail={usage.memory ? memoryDetail(usage.memory) : "—"}
        />
      )}
      {usage.gpus.map((gpu) => {
        const key = `gpu:${gpu.name ?? "gpu"}`;
        if (hidden.has(key)) return null;
        return (
          <Fragment key={key}>
            <MetricRow
              icon={<Monitor className="h-3.5 w-3.5" />}
              label={gpu.available && gpu.name ? `GPU · ${gpu.name}` : "GPU"}
              percent={gpu.available ? gpu.usedPercent : null}
              detail={gpu.available ? gpuTempDetail(gpu) : undefined}
            />
            {gpu.available &&
              gpu.vramUsedPercent !== null &&
              gpu.vramUsedPercent !== undefined && (
                <MetricRow
                  icon={<MemoryStick className="h-3.5 w-3.5" />}
                  label={gpu.name ? `VRAM · ${gpu.name}` : "VRAM"}
                  percent={gpu.vramUsedPercent}
                  detail={gpuDetail(gpu)}
                />
              )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function SystemMonitorWidget({
  initialCollapsed = false,
}: {
  initialCollapsed?: boolean;
} = {}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [twoColumn, setTwoColumn] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { usage, loadError, refreshing, refresh } = useSystemMonitor({
    enabled: true,
    intervalMs: collapsed ? SYSMON_POLL_COLLAPSED_MS : SYSMON_POLL_ACTIVE_MS,
  });

  useEffect(() => {
    if (!initialCollapsed) setCollapsed(loadCollapsed());
  }, [initialCollapsed]);

  useEffect(() => {
    setTwoColumn(loadTwoColumn());
    setHidden(loadHiddenItems());
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      saveCollapsed(next);
      return next;
    });
  };

  const toggleTwoColumn = () => {
    setTwoColumn((two) => {
      const next = !two;
      saveTwoColumn(next);
      return next;
    });
  };

  const toggleHidden = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveHiddenItems(next);
      return next;
    });
  };

  const avg = usage ? summaryPercent(usage) : null;
  const summaryTone: Tone = percentTone(avg);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label="システム使用率を開く"
        title="システム使用率を開く"
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-xs hover:bg-surface-2"
      >
        <Cpu className={cx("h-3.5 w-3.5", textClass[summaryTone])} />
        <span className="font-medium text-text">システム</span>
        {avg !== null && (
          <span className="font-mono text-muted">全体 {Math.round(avg)}%</span>
        )}
      </button>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col rounded-xl border border-border bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1">
        <Cpu className={cx("h-4 w-4", textClass[summaryTone])} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">
          システム使用率
        </span>
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
          onClick={() => setOptionsOpen((o) => !o)}
          aria-expanded={optionsOpen}
          aria-controls="sysmon-display-options"
          aria-label="表示項目"
          title="表示する項目を選択"
          className={cx(
            "h-6 w-6 rounded-md p-1 hover:bg-surface-2 hover:text-text",
            optionsOpen ? "bg-surface-2 text-text" : "text-faint",
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

      {optionsOpen && (
        <section
          id="sysmon-display-options"
          aria-label="表示する項目"
          className="shrink-0 border-b border-border px-3 py-2"
        >
          <p className="mb-1 min-w-0 text-[10px] font-medium text-muted">表示する項目</p>
          <ul className="flex flex-col gap-1">
            <ToggleRow label="CPU" checked={!hidden.has("cpu")} onToggle={() => toggleHidden("cpu")} />
            <ToggleRow label="RAM" checked={!hidden.has("ram")} onToggle={() => toggleHidden("ram")} />
            {usage?.gpus.map((gpu) => (
              <ToggleRow
                key={gpu.name ?? "gpu"}
                label={gpu.name ?? "GPU"}
                checked={!hidden.has(`gpu:${gpu.name ?? "gpu"}`)}
                onToggle={() => toggleHidden(`gpu:${gpu.name ?? "gpu"}`)}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="min-h-0 px-3 py-2.5">
        {loadError && (
          <p role="alert" className="text-[11px] text-danger">
            読み込みエラー: {loadError}
          </p>
        )}
        {!loadError && !usage && <p className="text-[11px] text-faint">読み込み中…</p>}
        {!loadError && usage && !usage.available && (
          <p className="text-[11px] text-faint">{usage.reason ?? "利用できません"}</p>
        )}
        {!loadError && usage && usage.available && (
          <MetricRows usage={usage} twoColumn={twoColumn} hidden={hidden} />
        )}
      </div>
    </div>
  );
}

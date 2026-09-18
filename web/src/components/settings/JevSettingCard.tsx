"use client";

import { Switch } from "@/components/ui";

const DEFAULT_THRESHOLD_OPTIONS = [
  0.5,
  0.55,
  0.6,
  0.65,
  0.7,
  0.75,
  0.8,
  0.85,
  0.9,
  0.95,
] as const;

type JevSettingCardProps = {
  title: string;
  description: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  enabledLabel: string;
  threshold: number;
  thresholdLabel: string;
  thresholdAriaLabel: string;
  onThresholdChange: (threshold: number) => void;
  thresholdHelp: string;
  thresholdOptions?: readonly number[];
};

export function JevSettingCard({
  title,
  description,
  enabled,
  onEnabledChange,
  enabledLabel,
  threshold,
  thresholdLabel,
  thresholdAriaLabel,
  onThresholdChange,
  thresholdHelp,
  thresholdOptions = DEFAULT_THRESHOLD_OPTIONS,
}: JevSettingCardProps) {
  const options = thresholdOptions.includes(threshold)
    ? thresholdOptions
    : [threshold, ...thresholdOptions];

  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text">{title}</p>
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        </div>
        <Switch
          checked={enabled}
          onChange={() => onEnabledChange(!enabled)}
          label={enabledLabel}
        />
      </div>
      {enabled && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{thresholdLabel}</span>
          <select
            aria-label={thresholdAriaLabel}
            className="h-8 rounded-lg border border-border bg-bg px-2 text-xs text-text outline-none focus:border-border-strong"
            value={String(threshold)}
            onChange={(event) => onThresholdChange(Number(event.target.value))}
          >
            {options.map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
          <span>{thresholdHelp}</span>
        </label>
      )}
    </div>
  );
}

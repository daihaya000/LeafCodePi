"use client";

import { Gauge } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import {
  AUTO_OPTIMIZE_MODES,
  autoOptimizeModeLabel,
  isAutoOptimizeMode,
  type AutoOptimizeMode,
} from "@/lib/auto-model";

export function AutoOptimizeSelect({
  value,
  onChange,
  disabled = false,
  className,
}: {
  value: AutoOptimizeMode;
  onChange: (value: AutoOptimizeMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <GhostSelect
      value={value}
      disabled={disabled}
      aria-label="Auto の最適化"
      icon={<Gauge className="h-3.5 w-3.5" />}
      valueLabel={autoOptimizeModeLabel(value)}
      onChange={(next) => {
        if (isAutoOptimizeMode(next)) onChange(next);
      }}
      className={className ?? "h-8 shrink-0"}
    >
      {AUTO_OPTIMIZE_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {autoOptimizeModeLabel(mode)}
        </option>
      ))}
    </GhostSelect>
  );
}

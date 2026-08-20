"use client";

import { Cpu } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import type { ModelOption } from "@/lib/types";

export function ModelSelect({
  value,
  options,
  disabled,
  onChange,
  className,
  title,
}: {
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
  title?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const grouped = new Map<string, ModelOption[]>();
  for (const option of options) {
    const list = grouped.get(option.providerID) ?? [];
    list.push(option);
    grouped.set(option.providerID, list);
  }

  return (
    <GhostSelect
      value={value}
      disabled={disabled || options.length === 0}
      aria-label="モデル"
      icon={<Cpu className="h-3.5 w-3.5" />}
      valueLabel={selected?.label ?? (options.length === 0 ? "モデルなし" : "モデル")}
      onChange={onChange}
      className={className}
      title={title ?? selected?.label ?? "モデル"}
    >
      {[...grouped.entries()].map(([provider, models]) => (
        <optgroup key={provider} label={provider}>
          {models.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </GhostSelect>
  );
}

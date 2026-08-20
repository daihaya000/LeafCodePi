"use client";

import { Brain } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import {
  THINKING_LEVEL_LABELS,
  thinkingLevelLabel,
} from "@/lib/thinking-levels";
import type { ThinkingLevel } from "@/lib/types";

export function ThinkingSelect({
  levels,
  value,
  onChange,
  disabled = false,
  className = "max-w-[8rem] shrink-0",
}: {
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
  className?: string;
}) {
  const options = levels.length > 0 ? levels : (["off"] as ThinkingLevel[]);
  // No graded effort → hide entirely (no static「思考なし」placeholder).
  if (options.length <= 1 && (options[0] ?? "off") === "off") {
    return null;
  }

  const effective = options.includes(value) ? value : options[0]!;

  return (
    <GhostSelect
      value={effective}
      disabled={disabled}
      aria-label="思考レベル"
      icon={<Brain className="h-3.5 w-3.5" />}
      valueLabel={thinkingLevelLabel(effective)}
      onChange={(next) => onChange(next as ThinkingLevel)}
      className={className}
    >
      {options.map((level) => (
        <option key={level} value={level}>
          {THINKING_LEVEL_LABELS[level]}
        </option>
      ))}
    </GhostSelect>
  );
}

"use client";

import { Ban, Sparkles } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import {
  SKILL_PERMISSION_OPTIONS,
  type SkillPermission,
} from "@/lib/skill-permission";

export function SkillPermissionSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: SkillPermission;
  onChange: (mode: SkillPermission) => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = SKILL_PERMISSION_OPTIONS.find((option) => option.value === value);
  return (
    <GhostSelect
      value={value}
      disabled={disabled}
      aria-label="スキル"
      title={current?.title}
      icon={
        value === "deny" ? (
          <Ban className="h-3.5 w-3.5" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )
      }
      valueLabel={current?.label ?? value}
      tone={value === "deny" ? "warning" : "default"}
      onChange={(next) => {
        if (next === "allow" || next === "deny") onChange(next);
      }}
      className={className}
    >
      {SKILL_PERMISSION_OPTIONS.map((option) => (
        <option key={option.value} value={option.value} title={option.title}>
          {option.label}
        </option>
      ))}
    </GhostSelect>
  );
}

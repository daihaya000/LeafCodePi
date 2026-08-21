"use client";

import { Bot, BotOff } from "lucide-react";
import {
  SUBAGENT_PERMISSION_OPTIONS,
  type SubagentPermission,
} from "@/lib/subagent-permission";
import { GhostSelect } from "@/components/ui";

export function SubagentPermissionSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: SubagentPermission;
  onChange: (mode: SubagentPermission) => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = SUBAGENT_PERMISSION_OPTIONS.find((o) => o.value === value);
  return (
    <GhostSelect
      value={value}
      disabled={disabled}
      aria-label="サブエージェント"
      title={current?.title}
      icon={
        value === "deny" ? (
          <BotOff className="h-3.5 w-3.5" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )
      }
      valueLabel={current?.label ?? value}
      tone={value === "allow" ? "warning" : "default"}
      onChange={(v) => {
        if (v === "allow" || v === "deny") onChange(v);
      }}
      className={className}
    >
      {SUBAGENT_PERMISSION_OPTIONS.map((o) => (
        <option key={o.value} value={o.value} title={o.title}>
          {o.label}
        </option>
      ))}
    </GhostSelect>
  );
}

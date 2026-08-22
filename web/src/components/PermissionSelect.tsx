"use client";

import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { PERMISSION_OPTIONS, type PermissionMode } from "@/lib/permission-gate";
import { GhostSelect } from "@/components/ui";

export function PermissionSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = PERMISSION_OPTIONS.find((o) => o.value === value);
  const icon =
    value === "allow" ? (
      <ShieldCheck className="h-3.5 w-3.5" />
    ) : value === "deny" ? (
      <Shield className="h-3.5 w-3.5" />
    ) : (
      <ShieldAlert className="h-3.5 w-3.5" />
    );

  return (
    <GhostSelect
      value={value}
      disabled={disabled}
      aria-label="権限承認"
      title={current?.title}
      icon={icon}
      valueLabel={current?.label ?? value}
      tone={value === "allow" ? "danger" : value === "deny" ? "warning" : "default"}
      onChange={(v) => {
        if (v === "allow" || v === "ask" || v === "deny") onChange(v);
      }}
      className={className}
    >
      {PERMISSION_OPTIONS.map((o) => (
        <option key={o.value} value={o.value} title={o.title}>
          {o.label}
        </option>
      ))}
    </GhostSelect>
  );
}

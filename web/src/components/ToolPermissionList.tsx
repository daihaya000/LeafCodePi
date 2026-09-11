"use client";

import { Eye, Pencil } from "lucide-react";
import { isWriteTool, toolNameLabel } from "@/lib/tool-labels";

type ToolPermissionListProps<T extends string> = {
  tools: readonly T[];
  selectedTools: readonly T[];
  disabled?: boolean;
  name?: string;
  onChange: (tools: T[]) => void;
};

export function ToolPermissionList<T extends string>({
  tools,
  selectedTools,
  disabled = false,
  name,
  onChange,
}: ToolPermissionListProps<T>) {
  const selected = new Set(selectedTools);
  const groups = [
    { kind: "write", label: "書き込み系", Icon: Pencil, tools: tools.filter(isWriteTool) },
    { kind: "read", label: "読み取り系", Icon: Eye, tools: tools.filter((tool) => !isWriteTool(tool)) },
  ] as const;
  const toolAriaLabel = (tool: string) => `${name ? `${name} の` : ""}${toolNameLabel(tool)}`;

  return (
    <div className="space-y-3">
      {groups.map(({ kind, label, Icon, tools: groupTools }) => (
        <div key={kind} data-tool-group={kind} role="group" aria-label={`${name ? `${name}の` : ""}${label}ツール`}>
          <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{label}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {groupTools.map((tool) => (
              <label key={tool} className="flex min-w-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected.has(tool)}
                  disabled={disabled}
                  aria-label={toolAriaLabel(tool)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(tool);
                    else next.delete(tool);
                    onChange([...next]);
                  }}
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                <span className="flex min-w-0 items-center gap-1 truncate" title={tool}>
                  <span aria-hidden="true" data-tool-access={kind} title={label}>
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                  </span>
                  <span className="truncate">{toolNameLabel(tool)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

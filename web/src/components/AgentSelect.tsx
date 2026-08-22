"use client";

import { Bot } from "lucide-react";
import { GhostSelect } from "@/components/ui";

/**
 * エージェント選択ドロップダウン。
 * agents は /api/agents の一覧（ビルトイン + ユーザー定義）から取得する。
 * 選択したエージェントはタスク全体のメイン対話者になる（value="" でデフォルトに戻す）。
 */
export function AgentSelect({
  value,
  agents,
  disabled,
  onChange,
  className,
}: {
  value: string;
  agents: string[];
  disabled?: boolean;
  onChange: (agent: string) => void;
  className?: string;
}) {
  return (
    <GhostSelect
      value={value}
      disabled={disabled}
      aria-label="エージェント"
      title={value ? `${value} がこのタスクの対話者になります` : "エージェント"}
      icon={<Bot className="h-3.5 w-3.5" />}
      valueLabel={value || "エージェント"}
      onChange={onChange}
      className={className}
    >
      <option value="">エージェント</option>
      {agents.map((agent) => (
        <option key={agent} value={agent}>
          {agent}
        </option>
      ))}
    </GhostSelect>
  );
}

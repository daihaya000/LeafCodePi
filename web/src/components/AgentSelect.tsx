"use client";

import { Bot } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import { DEFAULT_AGENT, resolveAgentSelection } from "@/lib/default-agent";

/**
 * エージェント選択ドロップダウン。
 * agents は /api/agents の一覧（ビルトイン + ユーザー定義）から取得する。
 * 選択したエージェントはタスク全体のメイン対話者になる。空値や不明値は
 * build（なければ先頭の有効なエージェント）へ正規化する。
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
  const selectableAgents = agents.filter((agent) => agent.trim());
  const selectedValue = resolveAgentSelection(value, selectableAgents) || DEFAULT_AGENT;

  return (
    <GhostSelect
      value={selectedValue}
      disabled={disabled}
      aria-label="エージェント"
      title={`${selectedValue} がこのタスクの対話者になります`}
      icon={<Bot className="h-3.5 w-3.5" />}
      valueLabel={selectedValue}
      onChange={onChange}
      className={className}
    >
      {selectableAgents.map((agent) => (
        <option key={agent} value={agent}>
          {agent}
        </option>
      ))}
    </GhostSelect>
  );
}

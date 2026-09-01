"use client";

import {
  Blocks,
  Bot,
  Bug,
  CheckCircle2,
  ClipboardList,
  Code2,
  Eye,
  FileText,
  FlaskConical,
  GitBranch,
  History,
  Palette,
  Search,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { GhostSelect } from "@/components/ui";
import {
  composerReferenceToolTitle,
  type ComposerReference,
} from "@/lib/composer-references";
import { DEFAULT_AGENT, resolveAgentSelection } from "@/lib/default-agent";

const AGENT_ICONS: Record<string, LucideIcon> = {
  build: Blocks,
  programmer: Code2,
  plan: ClipboardList,
  researcher: Search,
  reviewer: CheckCircle2,
  debugger: Bug,
  "docs-writer": FileText,
  "finance-expert": Wallet,
  "security-auditor": ShieldCheck,
  "test-writer": FlaskConical,
  "ui-ux-designer": Palette,
  "ui-ux-reviewer": Eye,
  "critical-architect": Blocks,
  "lead-programmer": GitBranch,
  retrospective: History,
};

function AgentRoleIcon({ name }: { name: string }) {
  const Icon = AGENT_ICONS[name] ?? Bot;
  return <Icon aria-hidden="true" data-agent-icon={name} className="h-3.5 w-3.5 shrink-0" />;
}

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
  agents: readonly (ComposerReference | string)[];
  disabled?: boolean;
  onChange: (agent: string) => void;
  className?: string;
}) {
  const selectableAgents = agents
    .map((agent) => (typeof agent === "string" ? { name: agent } : agent))
    .filter((agent) => agent.name.trim());
  const selectedValue = resolveAgentSelection(
    value,
    selectableAgents.map(({ name }) => name),
  ) || DEFAULT_AGENT;

  return (
    <GhostSelect
      value={selectedValue}
      disabled={disabled}
      aria-label="エージェント"
      title={`${selectedValue} がこのタスクの対話者になります`}
      icon={<AgentRoleIcon name={selectedValue} />}
      valueLabel={selectedValue}
      onChange={onChange}
      className={className}
    >
      {selectableAgents.map((agent) => (
        <option
          key={agent.name}
          value={agent.name}
          title={composerReferenceToolTitle(agent)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <AgentRoleIcon name={agent.name} />
            <span className="truncate">{agent.name}</span>
          </span>
        </option>
      ))}
    </GhostSelect>
  );
}

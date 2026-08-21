"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type AgentDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filePath: string;
  source: "user" | "builtin" | "package";
  tools?: string[];
};

type AgentsResponse = {
  agents: AgentDto[];
  agentsDir: string;
};

function AgentSwitch({
  name,
  enabled,
  busy,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${name} を${enabled ? "無効化" : "有効化"}`}
      disabled={busy}
      onClick={onToggle}
      className={cx(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        enabled ? "bg-primary" : "bg-surface-3",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform",
          enabled ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function AgentsSettings() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [agentsPath, setAgentsPath] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<AgentsResponse>("/api/agents")
      .then((result) => {
        setAgents(result.agents);
        setAgentsPath(result.agentsDir);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "エージェント一覧の取得に失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(agent: AgentDto) {
    if (busyId) return;
    setBusyId(agent.id);
    setError(null);
    try {
      const result = await sendJson<{ agents: AgentDto[] }>(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { enabled: !agent.enabled },
        "PATCH",
      );
      setAgents(result.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">エージェント（subagents）</h2>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        pi-subagents が提供するサブエージェントの有効／無効を切り替えます。定義は{" "}
        <span className="font-mono">~/.pi/agent/agents/&lt;name&gt;.md</span>{" "}
        に置き、YAML frontmatter で名前・説明・ツールを指定します。
      </p>
      {agentsPath && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-faint">
          <p className="break-all">{agentsPath}</p>
        </div>
      )}
      {loading && agents.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : agents.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          エージェントがありません。{" "}
          <span className="font-mono">~/.pi/agent/agents/&lt;name&gt;.md</span> に追加してください。
        </p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
          {agents.map((agent) => (
            <li
              key={agent.id}
              aria-busy={busyId === agent.id || undefined}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-text" title={agent.id}>
                    {agent.name}
                  </p>
                  <Badge tone={agent.source === "user" ? "warning" : "neutral"}>
                    {agent.source}
                  </Badge>
                  <Badge tone={agent.enabled ? "success" : "neutral"}>
                    {agent.enabled ? "有効" : "無効"}
                  </Badge>
                </div>
                {agent.description && (
                  <p className="mt-0.5 text-xs break-words text-faint">{agent.description}</p>
                )}
                {agent.tools && agent.tools.length > 0 && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{agent.tools.join(", ")}</p>
                )}
                <p className="mt-0.5 break-all font-mono text-[11px] text-faint">{agent.filePath}</p>
              </div>
              <AgentSwitch
                name={agent.name}
                enabled={agent.enabled}
                busy={busyId === agent.id}
                onToggle={() => void toggle(agent)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

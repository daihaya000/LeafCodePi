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

type AgentDraft = {
  name: string;
  description?: string;
  aliases?: string[];
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  async?: boolean;
  systemPrompt: string;
};

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; name: string }
  | { mode: "closed" };

const DEFAULT_TOOLS = "read, grep, find, ls";

function emptyDraft(): AgentDraft {
  return { name: "", description: "", tools: ["read", "grep", "find", "ls"], systemPrompt: "" };
}

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL_CLASS = "block text-xs font-medium text-muted";

function Field({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className={LABEL_CLASS}>{label}</span>
      <input
        className={`${INPUT_CLASS} mt-1`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function AgentEditor({
  mode,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  mode: "create" | "edit";
  initial: AgentDraft;
  busy: boolean;
  onSave: (draft: AgentDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [toolsText, setToolsText] = useState(initial.tools?.join(", ") ?? DEFAULT_TOOLS);

  const submit = () => {
    onSave({
      ...draft,
      tools: toolsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  };

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border bg-surface-2 p-3">
      <p className="text-sm font-medium">{mode === "create" ? "新規エージェント" : `編集: ${initial.name}`}</p>
      <Field label="名前" value={draft.name} disabled={mode === "edit"} onChange={(v) => setDraft({ ...draft, name: v })} />
      <Field label="説明" value={draft.description ?? ""} onChange={(v) => setDraft({ ...draft, description: v })} />
      <Field label="モデル（任意）" value={draft.model ?? ""} onChange={(v) => setDraft({ ...draft, model: v })} />
      <Field label="思考レベル（off/low/medium/high）" value={draft.thinking ?? ""} onChange={(v) => setDraft({ ...draft, thinking: v })} />
      <Field label="ツール（カンマ区切り）" value={toolsText} onChange={setToolsText} />
      <Field label="エイリアス（カンマ区切り）" value={draft.aliases?.join(", ") ?? ""} onChange={(v) => setDraft({ ...draft, aliases: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
      <Field label="フォールバックモデル（カンマ区切り）" value={draft.fallbackModels?.join(", ") ?? ""} onChange={(v) => setDraft({ ...draft, fallbackModels: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
      <label className="block">
        <span className={LABEL_CLASS}>システムプロンプト</span>
        <textarea
          className="mt-1 min-h-32 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-accent"
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy || !draft.name.trim()} onClick={submit}>
          保存
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}

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
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [editingDraft, setEditingDraft] = useState<AgentDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);

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

  async function openCreate() {
    setEditingDraft(emptyDraft());
    setEditor({ mode: "create" });
  }

  async function openEdit(agent: AgentDto) {
    if (agent.source !== "user") {
      setError("ビルトイン・パッケージエージェントは編集できません");
      return;
    }
    setError(null);
    try {
      const result = await getJson<{ draft: AgentDraft }>(`/api/agents/${encodeURIComponent(agent.id)}`);
      setEditingDraft(result.draft);
      setEditor({ mode: "edit", name: agent.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントの取得に失敗しました");
    }
  }

  async function saveDraft(draft: AgentDraft, mode: EditorState) {
    setSaving(true);
    setError(null);
    try {
      if (mode.mode === "create") {
        await sendJson<{ agents: AgentDto[] }>("/api/agents", draft, "POST");
      } else if (mode.mode === "edit") {
        await sendJson<{ agents: AgentDto[] }>(
          `/api/agents/${encodeURIComponent(mode.name)}`,
          draft,
          "PATCH",
        );
      }
      setEditor({ mode: "closed" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントの保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function remove(agent: AgentDto) {
    if (agent.source !== "user") {
      setError("ビルトイン・パッケージエージェントは削除できません");
      return;
    }
    if (!window.confirm(`エージェント「${agent.name}」を削除しますか？`)) return;
    setBusyId(agent.id);
    setError(null);
    try {
      const result = await sendJson<{ agents: AgentDto[] }>(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        undefined,
        "DELETE",
      );
      setAgents(result.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントの削除に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">エージェント（subagents）</h2>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
            再読込
          </Button>
          <Button variant="primary" size="sm" onClick={() => void openCreate()} disabled={loading || Boolean(busyId)}>
            ＋新規
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted">
        pi-subagents が提供するサブエージェントの一覧と有効／無効を管理します。ユーザー定義は{" "}
        <span className="font-mono">~/.pi/agent/agents/&lt;name&gt;.md</span> に保存されます。
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
          エージェントがありません。 「＋新規」で作成するか、{" "}
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
              <div className="flex shrink-0 flex-col items-end gap-1">
                <AgentSwitch
                  name={agent.name}
                  enabled={agent.enabled}
                  busy={busyId === agent.id}
                  onToggle={() => void toggle(agent)}
                />
                {agent.source === "user" && (
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" size="sm" onClick={() => void openEdit(agent)}>
                      編集
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void remove(agent)}>
                      削除
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editor.mode !== "closed" && (
        <AgentEditor
          mode={editor.mode}
          initial={editingDraft}
          busy={saving}
          onSave={(draft) => void saveDraft(draft, editor)}
          onCancel={() => setEditor({ mode: "closed" })}
        />
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

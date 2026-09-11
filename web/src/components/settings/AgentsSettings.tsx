"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import { AgentRoleIcon } from "@/components/AgentSelect";
import { ModelSelect } from "@/components/ModelSelect";
import { Badge, Button, GhostSelect, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { ALL_THINKING_LEVELS, THINKING_LEVEL_LABELS, isThinkingLevel } from "@/lib/thinking-levels";
import { BOT_TOOL_NAMES, type ModelOption, type ThinkingLevel } from "@/lib/types";

/** `false` = pi-subagents の明示的な thinking 無効。undefined = 既定に従う。 */
type AgentThinking = ThinkingLevel | false;

const EFFORT_DEFAULT_VALUE = "";
const EFFORT_DISABLED_VALUE = "false";

type AgentDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  model?: string;
  thinking?: AgentThinking;
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
  thinking?: AgentThinking;
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

const AGENT_TOOL_NAMES = BOT_TOOL_NAMES;
const AGENT_DEFAULT_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "question",
  "grep",
  "find",
  "ls",
  "memory_search",
  "memory_add",
  "memory_replace",
  "memory_remove",
  "session_search",
  "skill_manage",
  "todowrite",
  "tool_search",
] as const;

function emptyDraft(): AgentDraft {
  // Omit tools so new agents inherit pi defaults (same as package agents with tools unset).
  return { name: "", description: "", systemPrompt: "" };
}

function modelSelectionValue(model: string | undefined, options: readonly ModelOption[]): string {
  if (!model) return "";
  const trimmed = model.trim();
  return options.find(
    (option) =>
      option.value === trimmed ||
      `${option.providerID}/${option.modelID}` === trimmed ||
      option.modelID === trimmed,
  )?.value ?? trimmed;
}

function optionsForModel(model: string | undefined, options: readonly ModelOption[]): ModelOption[] {
  if (!model || options.some((option) => option.value === modelSelectionValue(model, options))) {
    return [...options];
  }
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  const separator = slash > 0 ? slash : trimmed.indexOf("::");
  const providerID = separator > 0 ? trimmed.slice(0, separator) : "設定済み";
  const modelID = separator > 0 ? trimmed.slice(separator + (slash > 0 ? 1 : 2)) : trimmed;
  return [
    { value: trimmed, label: `${trimmed}（未取得）`, providerID, modelID },
    ...options,
  ];
}

/** Agent settings save provider/model only, so account-scoped API options are logicalized. */
function agentModelOptions(options: readonly ModelOption[]): ModelOption[] {
  const byValue = new Map<string, ModelOption>();
  for (const option of options) {
    const normalized = {
      ...option,
      value: `${option.providerID}::${option.modelID}`,
    };
    delete normalized.accountId;
    delete normalized.accountLabel;
    if (!byValue.has(normalized.value)) byValue.set(normalized.value, normalized);
  }
  return [...byValue.values()];
}

function modelFromSelection(value: string, options: readonly ModelOption[]): string | null {
  if (!value) return null;
  const option = options.find((entry) => entry.value === value);
  if (!option || option.label.endsWith("（未取得）")) return value;
  return `${option.providerID}/${option.modelID}`;
}

function sortAgentRows(agents: readonly AgentDto[]): AgentDto[] {
  return [...agents].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "en"),
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL_CLASS = "block text-xs font-medium text-muted";
const AUTO_AGENT_PROMPT_SETTING_KEY = "auto-agent-prompt";
const AUTO_AGENT_PROMPT_MAX_LENGTH = 4_096;

function Field({
  label,
  value,
  disabled,
  autoFocus,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className={LABEL_CLASS}>{label}</span>
      <input
        className={`${INPUT_CLASS} mt-1`}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function AgentModelPicker({
  name,
  model,
  models,
  loading,
  busy,
  onChange,
}: {
  name: string;
  model?: string;
  models: readonly ModelOption[];
  loading: boolean;
  busy: boolean;
  onChange: (model: string | null) => void;
}) {
  const options = optionsForModel(model, models);
  const value = modelSelectionValue(model, options);

  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
      <span className={LABEL_CLASS}>モデル</span>
      <ModelSelect
        value={value}
        options={options}
        disabled={loading || busy}
        onChange={(next) => onChange(modelFromSelection(next, options))}
        ariaLabel={`${name} のモデル`}
        className="min-w-0 w-full sm:w-auto sm:flex-1 sm:min-w-48 sm:max-w-md"
        title={model ?? "モデルを選択"}
      />
      {model && (
        <Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => onChange(null)}>
          既定に戻す
        </Button>
      )}
      {loading && <span className="text-[11px] text-muted">モデルを読み込み中…</span>}
      {!loading && models.length === 0 && <span className="text-[11px] text-muted">利用可能なモデルがありません</span>}
    </div>
  );
}

/**
 * 選択可能なEffortはエージェントのモデルが受け付けるレベルだけ。未対応レベルを
 * 保存すると pi-subagents が `model:max` のような存在しないIDで子プロセスを
 * 起動して失敗する。モデル未指定（親継承）や未取得時は絞れないので全佯を返す。
 */
function effortLevelsFor(
  model: string | undefined,
  models: readonly ModelOption[],
  current: AgentThinking | undefined,
): ThinkingLevel[] {
  const supported = model
    ? models.find((option) => option.value === modelSelectionValue(model, models))?.thinkingLevels
    : undefined;
  const allowed = new Set<ThinkingLevel>(
    supported === undefined ? ALL_THINKING_LEVELS : supported,
  );
  // 保存済みの値は対応外でも現状を見せるために残す（false はレベルでないので除外）。
  if (current) allowed.add(current);
  return ALL_THINKING_LEVELS.filter((level) => allowed.has(level));
}

function effortLabel(value: AgentThinking | undefined): string {
  if (value === false) return "無効";
  return value ?? "既定";
}

function AgentEffortPicker({
  name,
  value,
  levels,
  busy,
  onChange,
}: {
  name: string;
  value?: AgentThinking;
  levels: readonly ThinkingLevel[];
  busy: boolean;
  onChange: (value: AgentThinking | null) => void;
}) {
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <span className={LABEL_CLASS}>Effort</span>
      <GhostSelect
        value={value === false ? EFFORT_DISABLED_VALUE : value ?? EFFORT_DEFAULT_VALUE}
        disabled={busy}
        aria-label={`${name} のEffort`}
        title="サブエージェントとして呼び出された時のEffort"
        icon={<Brain className="h-3.5 w-3.5" />}
        valueLabel={effortLabel(value)}
        onChange={(next) =>
          onChange(
            next === EFFORT_DEFAULT_VALUE
              ? null
              : next === EFFORT_DISABLED_VALUE
                ? false
                : isThinkingLevel(next)
                  ? next
                  : null,
          )
        }
        className="max-w-[8rem] shrink-0"
      >
        <option value={EFFORT_DEFAULT_VALUE}>既定</option>
        <option value={EFFORT_DISABLED_VALUE}>無効</option>
        {levels.map((level) => (
          <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
        ))}
      </GhostSelect>
    </div>
  );
}

function AgentToolsSettings({
  name,
  tools,
  editable,
  busy,
  onChange,
}: {
  name: string;
  tools?: readonly string[];
  editable: boolean;
  busy: boolean;
  onChange: (tools: string[]) => void;
}) {
  const selected = new Set((tools ?? AGENT_DEFAULT_TOOL_NAMES).map((tool) => tool.trim()).filter(Boolean));
  const toolNames = [...new Set([...AGENT_TOOL_NAMES, ...selected])];

  return (
    <section
      className="mt-3 space-y-2 rounded-xl border border-border bg-bg p-3"
      aria-label={`${name}のツール設定`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">使用するツール</span>
        {!editable && <span className="text-[11px] text-muted">読み取り専用</span>}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        {toolNames.map((tool) => (
          <label key={tool} className="flex min-w-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={selected.has(tool)}
              disabled={!editable || busy}
              aria-label={`${name} の${tool}`}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(tool);
                else next.delete(tool);
                onChange([...next]);
              }}
              className="h-4 w-4 shrink-0 accent-accent"
            />
            <span className="truncate" title={tool}>{tool}</span>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted">
        チェックを外したツールは、このエージェントから利用できません。
        {tools === undefined && "未指定のエージェントは既定のツールを表示しています。"}
      </p>
    </section>
  );
}

function AutoAgentPromptSettings() {
  const [prompt, setPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<{ value: string | null }>(`/api/settings/${AUTO_AGENT_PROMPT_SETTING_KEY}`)
      .then((result) => {
        const value = result.value ?? "";
        setPrompt(value);
        setSavedPrompt(value);
        setError(null);
        setNotice(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Autoエージェント設定の読み込みに失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const dirty = prompt !== savedPrompt;
  const disabled = loading || saving;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendJson<{ value: string | null }>(
        `/api/settings/${AUTO_AGENT_PROMPT_SETTING_KEY}`,
        { value: prompt.trim() ? prompt : "" },
        "PUT",
      );
      const value = result.value ?? "";
      setPrompt(value);
      setSavedPrompt(value);
      setNotice("保存しました。次回のAutoエージェント選定から有効です。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Autoエージェント設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="auto-agent-prompt-heading" className="mt-4 rounded-xl border border-border bg-surface-2 p-3">
      <h3 id="auto-agent-prompt-heading" className="text-sm font-medium">Autoエージェント</h3>
      <p className="mt-1 text-xs text-muted">
        会話内容から担当エージェントを選ぶモデルへの追加指示です。空欄なら既定の選定指示だけを使います。
      </p>
      <label className="mt-3 block text-sm">
        <span className={LABEL_CLASS}>モデル選定者向けプロンプト</span>
        <textarea
          aria-label="モデル選定者向けプロンプト"
          value={prompt}
          maxLength={AUTO_AGENT_PROMPT_MAX_LENGTH}
          rows={6}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            setPrompt(event.target.value);
            setNotice(null);
          }}
          className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs leading-5 text-text outline-none focus:border-accent disabled:opacity-50"
          placeholder="Autoエージェントの選定方針を追加で指定"
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => reload()}>
          再読込
        </Button>
        <Button type="button" variant="primary" size="sm" busy={saving} disabled={disabled || !dirty} onClick={() => void save()}>
          保存
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      {notice && <p className="mt-2 text-xs text-success" role="status">{notice}</p>}
    </section>
  );
}

function AgentEditor({
  mode,
  initial,
  busy,
  models,
  modelsLoading,
  onSave,
  onCancel,
}: {
  mode: "create" | "edit";
  initial: AgentDraft;
  busy: boolean;
  models: readonly ModelOption[];
  modelsLoading: boolean;
  onSave: (draft: AgentDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);

  const submit = () => {
    onSave(draft);
  };

  return (
    <section
      aria-labelledby="agent-editor-heading"
      className="mt-3 space-y-3 rounded-xl border border-border bg-surface-2 p-3"
    >
      <h3 id="agent-editor-heading" className="text-sm font-medium">
        {mode === "create" ? "新規エージェント" : `編集: ${initial.name}`}
      </h3>
      <Field
        label="名前"
        value={draft.name}
        disabled={mode === "edit"}
        autoFocus={mode === "create"}
        onChange={(v) => setDraft({ ...draft, name: v })}
      />
      <Field
        label="説明"
        value={draft.description ?? ""}
        autoFocus={mode === "edit"}
        onChange={(v) => setDraft({ ...draft, description: v })}
      />
      <AgentModelPicker
        name={draft.name || "新規エージェント"}
        model={draft.model}
        models={models}
        loading={modelsLoading}
        busy={busy}
        onChange={(model) => setDraft({ ...draft, model: model ?? undefined })}
      />
      <AgentEffortPicker
        name={draft.name || "新規エージェント"}
        value={draft.thinking}
        levels={effortLevelsFor(draft.model, models, draft.thinking)}
        busy={busy}
        onChange={(thinking) => setDraft({
          ...draft,
          thinking: thinking === null ? undefined : thinking,
        })}
      />
      <AgentToolsSettings
        name={draft.name || "新規エージェント"}
        tools={draft.tools}
        editable
        busy={busy}
        onChange={(tools) => setDraft({ ...draft, tools })}
      />
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
    </section>
  );
}

export function AgentsSettings() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agentsPath, setAgentsPath] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [editingDraft, setEditingDraft] = useState<AgentDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setModelsLoading(true);
    void Promise.allSettled([
      getJson<AgentsResponse>("/api/agents"),
      getJson<{ models: ModelOption[] }>("/api/models"),
    ])
      .then(([agentsResult, modelsResult]) => {
        const errors: string[] = [];
        if (agentsResult.status === "fulfilled") {
          setAgents(sortAgentRows(agentsResult.value.agents));
          setAgentsPath(agentsResult.value.agentsDir);
        } else {
          errors.push(
            agentsResult.reason instanceof Error
              ? agentsResult.reason.message
              : "エージェント一覧の取得に失敗しました",
          );
        }
        if (modelsResult.status === "fulfilled") {
          setModels(agentModelOptions(modelsResult.value.models));
        } else {
          errors.push("モデル一覧の取得に失敗しました");
        }
        setError(errors[0] ?? null);
      })
      .finally(() => {
        setLoading(false);
        setModelsLoading(false);
      });
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
      setAgents(sortAgentRows(result.agents));
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function changeModel(agent: AgentDto, model: string | null) {
    if (busyId) return;
    setBusyId(agent.id);
    setError(null);
    const selected = model
      ? models.find((option) => option.value === modelSelectionValue(model, models))
      : undefined;
    const clearUnsupportedThinking =
      typeof agent.thinking === "string" &&
      selected?.thinkingLevels !== undefined &&
      !selected.thinkingLevels.includes(agent.thinking);
    try {
      const result = await sendJson<{ agents: AgentDto[] }>(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { model, ...(clearUnsupportedThinking ? { thinking: null } : {}) },
        "PATCH",
      );
      setAgents(sortAgentRows(result.agents));
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントのモデル保存に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function changeThinking(agent: AgentDto, thinking: AgentThinking | null) {
    if (busyId) return;
    setBusyId(agent.id);
    setError(null);
    try {
      const result = await sendJson<{ agents: AgentDto[] }>(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { thinking },
        "PATCH",
      );
      setAgents(sortAgentRows(result.agents));
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントのEffort保存に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function changeTools(agent: AgentDto, tools: string[]) {
    if (busyId || agent.source !== "user") return;
    setBusyId(agent.id);
    setError(null);
    try {
      const result = await sendJson<{ agents: AgentDto[] }>(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { tools },
        "PATCH",
      );
      setAgents(sortAgentRows(result.agents));
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントのツール権限保存に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  function openCreate(trigger: HTMLButtonElement) {
    editorTriggerRef.current = trigger;
    setEditingDraft(emptyDraft());
    setEditor({ mode: "create" });
  }

  async function openEdit(agent: AgentDto, trigger: HTMLButtonElement) {
    editorTriggerRef.current = trigger;
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

  function closeEditor() {
    setEditor({ mode: "closed" });
    editorTriggerRef.current?.focus();
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
      closeEditor();
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
      setAgents(sortAgentRows(result.agents));
    } catch (err) {
      setError(err instanceof Error ? err.message : "エージェントの削除に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">エージェント（subagents）</h3>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
            再読込
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={(event) => openCreate(event.currentTarget)}
            disabled={loading || Boolean(busyId)}
          >
            ＋新規
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted">
        pi-subagents が提供するサブエージェントの有効／無効とモデル・Effortを管理します。ここでのモデル・Effortはサブエージェントとして呼び出された時だけ使われ、直接選択時はComposerの設定を使います。ユーザー定義は{" "}
        <span className="font-mono">~/.pi/agent/agents/&lt;name&gt;.md</span> に保存されます。
      </p>
      {editor.mode !== "closed" && (
        <AgentEditor
          key={editor.mode === "edit" ? editor.name : "create"}
          mode={editor.mode}
          initial={editingDraft}
          busy={saving}
          models={models}
          modelsLoading={modelsLoading}
          onSave={(draft) => void saveDraft(draft, editor)}
          onCancel={closeEditor}
        />
      )}
      {agentsPath && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
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
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {agents.map((agent) => (
            <li
              key={agent.id}
              aria-busy={busyId === agent.id || undefined}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AgentRoleIcon name={agent.name} />
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
                  <p className="mt-0.5 text-xs break-words text-muted">{agent.description}</p>
                )}
                <AgentToolsSettings
                  name={agent.name}
                  tools={agent.tools}
                  editable={agent.source === "user"}
                  busy={busyId === agent.id}
                  onChange={(tools) => void changeTools(agent, tools)}
                />
                <AgentModelPicker
                  name={agent.name}
                  model={agent.model}
                  models={models}
                  loading={modelsLoading}
                  busy={busyId === agent.id}
                  onChange={(model) => void changeModel(agent, model)}
                />
                <AgentEffortPicker
                  name={agent.name}
                  value={agent.thinking}
                  levels={effortLevelsFor(agent.model, models, agent.thinking)}
                  busy={busyId === agent.id}
                  onChange={(thinking) => void changeThinking(agent, thinking)}
                />
                <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{agent.filePath}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Switch
                  checked={agent.enabled}
                  onChange={() => void toggle(agent)}
                  label={`${agent.name} を${agent.enabled ? "無効化" : "有効化"}`}
                  busy={busyId === agent.id}
                />
                {agent.source === "user" && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(event) => void openEdit(agent, event.currentTarget)}
                    >
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
      <AutoAgentPromptSettings />
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

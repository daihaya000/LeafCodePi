"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, FolderGit2, GitBranch } from "lucide-react";
import { CollaborationNotice, useCollaborationRoom } from "@/components/CollaborationStatus";
import { AddProjectButton } from "@/components/AddProjectButton";
import { AgentSelect } from "@/components/AgentSelect";
import { AccountSelect } from "@/components/AccountSelect";
import { Composer, type ComposerAttachment, type ComposerReference } from "@/components/Composer";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { NextTaskSuggest } from "@/components/home/NextTaskSuggest";
import { pasteImage } from "@/lib/clipboard-image";
import { ModelSelect } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { SubagentPermissionSelect } from "@/components/SubagentPermissionSelect";
import { SkillPermissionSelect } from "@/components/SkillPermissionSelect";
import { PermissionSelect } from "@/components/PermissionSelect";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";
import { Button, GhostSelect } from "@/components/ui";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import { DEFAULT_AGENT, readStoredAgent, writeStoredAgent } from "@/lib/default-agent";
import {
  readSelectedAccountId,
  writeSelectedAccountId,
} from "@/lib/selected-account";
import { defaultThinkingLevel, isThinkingLevel } from "@/lib/thinking-levels";
import {
  readSubagentPermission,
  writeSubagentPermission,
  type SubagentPermission,
} from "@/lib/subagent-permission";
import {
  readSkillPermission,
  writeSkillPermission,
  type SkillPermission,
} from "@/lib/skill-permission";
import {
  readPermissionMode,
  writePermissionMode,
  type PermissionMode,
} from "@/lib/permission-gate";
import type { HealthDto, ModelOption, ProjectDto, TaskSummary, ThinkingLevel } from "@/lib/types";

const MODEL_KEY = "leafcodepi.defaultModel";
const THINKING_KEY = "leafcodepi.thinkingLevel";

export function HomeView({ initialProjectId }: { initialProjectId?: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [accountId, setAccountId] = useState<string | null>(() => readSelectedAccountId());
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [prompt, setPrompt] = useState("");
  const [goalLoopEnabled, setGoalLoopEnabled] = useState(false);
  const [goalLoopAcceptance, setGoalLoopAcceptance] = useState("");
  const [goalLoopMaxTurns, setGoalLoopMaxTurns] = useState(10);
  const [goalLoopCooldownSeconds, setGoalLoopCooldownSeconds] = useState(0);
  const [goalLoopForceFullRun, setGoalLoopForceFullRun] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [agents, setAgents] = useState<ComposerReference[]>([]);
  const [skills, setSkills] = useState<ComposerReference[]>([]);
  const [agent, setAgent] = useState(() => readStoredAgent() || DEFAULT_AGENT);
  const [subagentPermission, setSubagentPermission] = useState<SubagentPermission>(
    () => readSubagentPermission(),
  );
  const [skillPermission, setSkillPermission] = useState<SkillPermission>(
    () => readSkillPermission(),
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readPermissionMode());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  const { room: collaborationRoom, refresh: refreshCollaborationRoom } = useCollaborationRoom(projectId || null);
  const selectedProject = projects.find((project) => project.id === projectId);
  const selectedModel = models.find((option) => option.value === model);
  const thinkingLevels = useMemo(
    () => selectedModel?.thinkingLevels ?? (["off"] as ThinkingLevel[]),
    [selectedModel],
  );

  const refresh = useCallback(async () => {
    const [projectRes, modelRes, healthRes, agentRes, skillRes] = await Promise.allSettled([
      getJson<{ projects: ProjectDto[] }>("/api/projects"),
      getJson<{ models: ModelOption[] }>("/api/models"),
      getJson<HealthDto>("/api/health"),
      getJson<{ agents: { name: string; description?: string; enabled: boolean }[] }>("/api/agents"),
      getJson<{ skills: { name: string; description?: string; enabled: boolean }[] }>("/api/skills"),
    ]);
    if (projectRes.status === "fulfilled") {
      setProjects(projectRes.value.projects);
      setProjectId((current) => {
        if (current && projectRes.value.projects.some((project) => project.id === current)) return current;
        return projectRes.value.projects[0]?.id ?? "";
      });
    }
    if (modelRes.status === "fulfilled") {
      setModels(modelRes.value.models);
      setModel((current) => {
        if (current && modelRes.value.models.some((option) => option.value === current)) return current;
        const stored = localStorage.getItem(MODEL_KEY) ?? "";
        if (stored && modelRes.value.models.some((option) => option.value === stored)) return stored;
        return modelRes.value.models[0]?.value ?? "";
      });
    }
    if (healthRes.status === "fulfilled") setHealth(healthRes.value);
    if (agentRes.status === "fulfilled") {
      const enabledAgents = agentRes.value.agents
        .filter((a) => a.enabled)
        .map(({ name, description }) => ({ name, description }));
      const enabledAgentNames = enabledAgents.map(({ name }) => name);
      setAgents(enabledAgents);
      setAgent((current) => {
        if (current && enabledAgentNames.includes(current)) return current;
        const stored = readStoredAgent();
        if (stored && enabledAgentNames.includes(stored)) return stored;
        // 本家 LeafCode と同じく build を既定対話者にする。
        if (enabledAgentNames.includes(DEFAULT_AGENT)) return DEFAULT_AGENT;
        return "";
      });
    }
    if (skillRes.status === "fulfilled") {
      setSkills(
        skillRes.value.skills
          .filter((skill) => skill.enabled)
          .map(({ name, description }) => ({ name, description })),
      );
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const storedThinking = localStorage.getItem(THINKING_KEY);
    if (isThinkingLevel(storedThinking)) setThinkingLevel(storedThinking);
    void refresh();
  }, [refresh]);

  // 選択アカウントの変更でモデル一覧を張り替える（選択 = モデル一覧の source of truth）。
  // Phase 6 で /api/models がアカウント別ランタイムへ解決される。accountId 未指定時は
  // URL が初期取得と一致するため getJson の統合で二重フェッチにならない。
  useEffect(() => {
    let cancelled = false;
    getJson<{ models: ModelOption[] }>("/api/models", { accountId: accountId ?? undefined })
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        setModel((current) => {
          if (current && res.models.some((option) => option.value === current)) return current;
          const stored = localStorage.getItem(MODEL_KEY) ?? "";
          if (stored && res.models.some((option) => option.value === stored)) return stored;
          return res.models[0]?.value ?? "";
        });
      })
      .catch(() => {
        /* 初期 refresh() の失敗表示に任せる */
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (initialProjectId !== undefined) setProjectId(initialProjectId);
  }, [initialProjectId]);

  useEffect(() => {
    if (thinkingLevels.includes(thinkingLevel)) return;
    // 現レベルが新モデルに無ければ既定（medium 相当）へ。最高レベルへの
    // 暗黙昇格は Qwen 切替で長ループを招いたためしない。
    const safeLevel = defaultThinkingLevel(thinkingLevels);
    setThinkingLevel(safeLevel);
    localStorage.setItem(THINKING_KEY, safeLevel);
  }, [thinkingLevels, thinkingLevel]);

  useEffect(() => {
    if (health?.engineOk !== false) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [health?.engineOk, refresh]);

  function addImageFiles(files: FileList) {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const uri = String(reader.result ?? "");
        setAttachments((current) => [...current, { uri, mime: file.type, name: file.name }]);
      };
      reader.readAsDataURL(file);
    });
  }

  async function submit() {
    if (!prompt.trim() || !projectId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (goalLoopEnabled && attachments.length > 0) {
        throw new Error("Goal loop の開始では画像添付は使えません");
      }
      const images = attachments
        .map((attachment) => {
          const comma = attachment.uri.indexOf(",");
          if (comma < 0) return null;
          return { mimeType: attachment.mime, data: attachment.uri.slice(comma + 1) };
        })
        .filter((item): item is { mimeType: string; data: string } => item !== null);
      const result = await sendJson<{ task: TaskSummary }>("/api/tasks", {
        projectId,
        prompt,
        model,
        thinkingLevel,
        images,
        ...(agent ? { agent } : {}),
        ...(accountId ? { accountId } : {}),
        subagentPermission,
        permissionMode,
        skillPermission,
        ...(goalLoopEnabled
          ? {
              goalLoop: {
                enabled: true,
                acceptance: goalLoopAcceptance,
                maxTurns: goalLoopMaxTurns,
                cooldownSeconds: goalLoopCooldownSeconds,
                forceFullRun: goalLoopForceFullRun,
              },
            }
          : {}),
      });
      localStorage.setItem(MODEL_KEY, model);
      localStorage.setItem(THINKING_KEY, thinkingLevel);
      notifyTasksChanged();
      router.push(`/task/${result.task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "タスクを開始できません");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <MobileMenuHeader />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip">
        <main className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-12 pb-[max(6rem,env(safe-area-inset-bottom))]">
          <section>
            <h1 className="mb-6 flex items-center justify-center gap-2 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.svg" alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-[6px] object-contain sm:h-8 sm:w-8" />
              <span>LeafCodePi</span>
            </h1>
            <div className="mx-auto mb-3 flex max-w-5xl items-center justify-start gap-2 overflow-x-auto px-1 py-1">
              <GhostSelect
                value={projectId}
                disabled={submitting}
                aria-label="プロジェクト"
                icon={<FolderGit2 className="h-3.5 w-3.5" />}
                valueLabel={selectedProject ? selectedProject.name : "プロジェクトなし"}
                onChange={setProjectId}
                className="min-w-0 max-w-[11rem] shrink sm:max-w-56"
                title={selectedProject?.name ?? "プロジェクトなし"}
                action={
                  <AddProjectButton
                    label="プロジェクトを追加"
                    buttonVariant="ghost"
                    buttonSize="sm"
                    className="w-full"
                    onAdded={(project) => {
                      void refresh().then(() => setProjectId(project.id));
                    }}
                  />
                }
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </GhostSelect>
              <GhostSelect
                value="current_folder"
                disabled
                aria-label="作業場所"
                icon={<GitBranch className="h-3.5 w-3.5" />}
                valueLabel="そのまま"
                onChange={() => {}}
                className="min-w-0 max-w-[9rem] shrink sm:max-w-40"
                title="MVP はプロジェクトフォルダを直接使います"
              >
                <option value="current_folder">そのまま</option>
              </GhostSelect>
            </div>
            {collaborationRoom && (collaborationRoom.leaseConflicts > 0 || collaborationRoom.pendingAsks > 0 || !collaborationRoom.ready) && (
              <div className="mx-auto mb-3 max-w-5xl">
                <CollaborationNotice
                  projectId={projectId || null}
                  room={collaborationRoom}
                  onResolved={() => void refreshCollaborationRoom()}
                />
              </div>
            )}
            {goalLoopEnabled && (
              <div className="mx-auto max-w-5xl">
                <GoalLoopOptions
                  acceptance={goalLoopAcceptance}
                  maxTurns={goalLoopMaxTurns}
                  cooldownSeconds={goalLoopCooldownSeconds}
                  forceFullRun={goalLoopForceFullRun}
                  disabled={submitting}
                  onAcceptanceChange={setGoalLoopAcceptance}
                  onMaxTurnsChange={setGoalLoopMaxTurns}
                  onCooldownSecondsChange={setGoalLoopCooldownSeconds}
                  onForceFullRunChange={setGoalLoopForceFullRun}
                />
              </div>
            )}
            <Composer
              form={{
                ariaLabel: "タスク作成",
                onSubmit: (event) => {
                  event.preventDefault();
                  void submit();
                },
              }}
              className="relative mx-auto max-w-5xl rounded-2xl border border-border bg-bg px-3 py-2 shadow-sm"
              attachments={attachments}
              onRemoveAttachment={(index) =>
                setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
              }
              attachmentRemovalDisabled={submitting}
              textarea={{
                ref: textareaRef,
                value: prompt,
                rows: 2,
                style: { fontSize: "16px" },
                ariaLabel: "タスクの説明",
                busy: submitting,
                readOnly: submitting,
                onChange: (event) => setPrompt(event.target.value),
                onValueChange: setPrompt,
                onPaste: (event) => {
                  if (pasteImage(addImageFiles, event)) event.preventDefault();
                },
                onCompositionStart: () => {
                  composingRef.current = true;
                },
                onCompositionEnd: () => {
                  composingRef.current = false;
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composingRef.current) {
                    event.preventDefault();
                    void submit();
                  }
                },
                placeholder: "タスクを説明してください…（Ctrl+Enter で開始）",
                className: "w-full resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-faint",
              }}
              references={{ skills, agents }}
              attachmentControl={{
                inputRef: fileInputRef,
                inputDisabled: submitting || goalLoopEnabled,
                buttonDisabled: submitting || goalLoopEnabled,
                buttonTitle: "画像を添付",
                onFilesSelected: addImageFiles,
                onTrigger: () => fileInputRef.current?.click(),
              }}
              toolbar={
                <>
                  <AccountSelect
                    value={accountId}
                    disabled={submitting}
                    onChange={(next) => {
                      setAccountId(next);
                      writeSelectedAccountId(next);
                    }}
                    className="min-w-0 max-w-[9rem] shrink sm:max-w-[10rem]"
                  />
                  <ModelSelect
                    value={model}
                    disabled={submitting}
                    options={models}
                    onChange={(value) => {
                      setModel(value);
                      localStorage.setItem(MODEL_KEY, value);
                    }}
                    className="min-w-0 max-w-[9rem] shrink sm:max-w-48"
                  />
                  <ThinkingSelect
                    levels={thinkingLevels}
                    value={thinkingLevel}
                    disabled={submitting}
                    onChange={(value) => {
                      setThinkingLevel(value);
                      localStorage.setItem(THINKING_KEY, value);
                    }}
                    className="min-w-0 max-w-[7rem] shrink sm:max-w-[8rem]"
                  />
                  {agents.length > 0 && (
                    <AgentSelect
                      value={agent}
                      agents={agents.map(({ name }) => name)}
                      disabled={submitting}
                      onChange={(value) => {
                        setAgent(value);
                        writeStoredAgent(value);
                      }}
                      className="min-w-0 max-w-[8rem] shrink sm:max-w-40"
                    />
                  )}
                  <PermissionSelect
                    value={permissionMode}
                    disabled={submitting}
                    onChange={(mode) => {
                      setPermissionMode(mode);
                      writePermissionMode(mode);
                    }}
                    className="h-8 shrink-0"
                  />
                  <SkillPermissionSelect
                    value={skillPermission}
                    disabled={submitting}
                    onChange={(mode) => {
                      setSkillPermission(mode);
                      writeSkillPermission(mode);
                    }}
                    className="h-8 shrink-0"
                  />
                  <SubagentPermissionSelect
                    value={subagentPermission}
                    disabled={submitting}
                    onChange={(mode) => {
                      setSubagentPermission(mode);
                      writeSubagentPermission(mode);
                    }}
                    className="h-8 shrink-0"
                  />
                  <GoalLoopToggle
                    enabled={goalLoopEnabled}
                    disabled={submitting}
                    onToggle={() => setGoalLoopEnabled((value) => !value)}
                  />
                </>
              }
              action={
                <Button
                  variant="primary"
                  size="icon"
                  type="submit"
                  aria-label="タスク開始"
                  className="shrink-0"
                  busy={submitting}
                  disabled={!prompt.trim() || !projectId || submitting || health?.engineOk === false}
                >
                  {!submitting && <ArrowUp className="h-4.5 w-4.5" />}
                </Button>
              }
            />
            <NextTaskSuggest
              projectId={projectId}
              model={model}
              disabled={submitting || health?.engineOk === false}
              onApply={(suggestion) => {
                setPrompt(suggestion);
                textareaRef.current?.focus();
              }}
            />
            {loaded && health && !health.engineOk && (
              <p className="mx-auto mt-3 max-w-2xl rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning">
                Pi に利用可能なモデルがありません。設定で API キー（ANTHROPIC_API_KEY など）または ~/.pi/agent/auth.json を確認してください。
              </p>
            )}
            {error && (
              <p role="alert" className="mx-auto mt-3 max-w-2xl break-all rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

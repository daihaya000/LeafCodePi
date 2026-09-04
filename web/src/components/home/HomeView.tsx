"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, FolderGit2 } from "lucide-react";
import { AddProjectButton } from "@/components/AddProjectButton";
import { AgentSelect } from "@/components/AgentSelect";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import { Composer, type ComposerAttachment, type ComposerReference } from "@/components/Composer";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { NextTaskSuggest } from "@/components/home/NextTaskSuggest";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { SubagentPermissionSelect } from "@/components/SubagentPermissionSelect";
import { SkillPermissionSelect } from "@/components/SkillPermissionSelect";
import { PermissionSelect } from "@/components/PermissionSelect";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";
import { Button, GhostSelect } from "@/components/ui";
import {
  AUTO_MODEL_OPTION,
  AUTO_MODEL_VALUE,
  type AutoDecision,
} from "@/lib/auto-model";
import {
  AUTO_OPTIMIZE_SETTING_KEY,
  AUTO_ROUTE_OVERRIDES_SETTING_KEY,
  hasStoredAutoSetting,
  readAutoOptimizeMode,
  readAutoRouteConfig,
  readAutoSettingsFromServer,
  subscribeAutoSetting,
  writeAutoOptimizeMode,
  writeAutoRouteConfig,
  writeAutoSettingToServer,
} from "@/lib/auto-settings";
import { AUTO_TASK_PROMPT_MAX, writeAutoTaskRecord } from "@/lib/auto-task-record";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import { DEFAULT_AGENT, readStoredAgent, resolveAgentSelection, writeStoredAgent } from "@/lib/default-agent";
import {
  readStoredThinkingLevel,
  resolveThinkingLevel,
  writeStoredThinkingLevel,
} from "@/lib/thinking-levels";
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
import { NO_PROJECT_NAME, type HealthDto, type ModelOption, type ProjectDto, type TaskSummary, type ThinkingLevel } from "@/lib/types";
import type { AutoOptimizeMode } from "@/lib/auto-model";

const MODEL_KEY = "leafcodepi.defaultModel";

/** アカウントタグ付きモデルの value を Pi が解釈できる「provider::model」へ戻す。 */
function plainModelValue(modelValue: string, models: ModelOption[]): string {
  const option = models.find((o) => o.value === modelValue);
  if (!option?.accountId) return modelValue;
  return `${option.providerID}::${option.modelID}`;
}

export function HomeView({
  initialProjectId,
  initialNoProject = false,
}: {
  initialProjectId?: string;
  initialNoProject?: boolean;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  // undefined = project list has not resolved; null = explicit no-project mode.
  const [projectId, setProjectId] = useState<string | null | undefined>(
    initialNoProject ? null : initialProjectId,
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [model, setModel] = useState("");
  const [autoOptimizeMode, setAutoOptimizeMode] = useState<AutoOptimizeMode>(
    () => readAutoOptimizeMode(),
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    () => readStoredThinkingLevel() ?? "off",
  );
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
  const modelsRef = useRef<ModelOption[]>([]);

  const selectedProject = projectId
    ? projects.find((project) => project.id === projectId)
    : undefined;
  const modelOptions = useMemo(() => [AUTO_MODEL_OPTION, ...models], [models]);
  const selectedModel = modelOptions.find((option) => option.value === model);
  const thinkingLevels = useMemo(
    () => selectedModel?.thinkingLevels ?? [],
    [selectedModel],
  );

  const refresh = useCallback(async () => {
    if (modelsRef.current.length === 0) setModelsLoading(true);
    const modelRequest = getJson<{ models: ModelOption[] }>("/api/models");
    void modelRequest
      .then((result) => {
        const nextModels = result.models;
        const previousModels = modelsRef.current;
        modelsRef.current = nextModels;
        setModels(nextModels);
        const nextOptions = [AUTO_MODEL_OPTION, ...nextModels];
        setModel((current) => {
          const preserved = modelOptionForValue(nextOptions, current);
          if (preserved) return preserved.value;
          const previous = modelOptionForValue(previousModels, current);
          const migrated = previous && modelOptionForValue(nextOptions, previous.value);
          if (migrated) return migrated.value;
          const stored = localStorage.getItem(MODEL_KEY) ?? "";
          return modelOptionForValue(nextOptions, stored)?.value ?? nextModels[0]?.value ?? "";
        });
        setModelsLoading(false);
      })
      .catch(() => setModelsLoading(false));

    const [projectRes, healthRes, agentRes, skillRes] = await Promise.allSettled([
      getJson<{ projects: ProjectDto[] }>("/api/projects"),
      getJson<HealthDto>("/api/health"),
      getJson<{ agents: { name: string; description?: string; enabled: boolean; tools?: string[] }[] }>("/api/agents"),
      getJson<{ skills: { name: string; description?: string; enabled: boolean }[] }>("/api/skills"),
    ]);
    if (projectRes.status === "fulfilled") {
      setProjects(projectRes.value.projects);
      setProjectId((current) => {
        if (current === null) return null;
        if (current && projectRes.value.projects.some((project) => project.id === current)) return current;
        return projectRes.value.projects[0]?.id ?? null;
      });
    }
    if (healthRes.status === "fulfilled") setHealth(healthRes.value);
    if (agentRes.status === "fulfilled") {
      const enabledAgents = agentRes.value.agents
        .filter((a) => a.enabled)
        .map(({ name, description, tools }) => ({ name, description, tools }));
      const enabledAgentNames = enabledAgents.map(({ name }) => name);
      setAgents(enabledAgents);
      setAgent((current) => resolveAgentSelection(current || readStoredAgent(), enabledAgentNames));
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
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (initialNoProject) {
      setProjectId(null);
    } else if (initialProjectId !== undefined) {
      setProjectId(initialProjectId);
    }
  }, [initialNoProject, initialProjectId]);

  useEffect(
    () =>
      subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, () =>
        setAutoOptimizeMode(readAutoOptimizeMode()),
      ),
    [],
  );

  useEffect(() => {
    let active = true;
    void readAutoSettingsFromServer().then((snapshot) => {
      if (!active) return;
      if (
        snapshot.mode &&
        !hasStoredAutoSetting(AUTO_OPTIMIZE_SETTING_KEY)
      ) {
        writeAutoOptimizeMode(snapshot.mode);
        setAutoOptimizeMode(snapshot.mode);
      }
      if (
        snapshot.routeConfig &&
        !hasStoredAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY)
      ) {
        writeAutoRouteConfig(snapshot.routeConfig);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedModel) return;
    const safeLevel = resolveThinkingLevel(thinkingLevels, thinkingLevel);
    if (safeLevel === thinkingLevel) return;
    // 現レベルが新モデルに無ければ既定（medium 相当）へ。最高レベルへの
    // 暗黙昇格は Qwen 切替で長ループを招いたためしない。
    setThinkingLevel(safeLevel);
    writeStoredThinkingLevel(safeLevel);
  }, [selectedModel, thinkingLevel, thinkingLevels]);

  useEffect(() => {
    if (health?.engineOk !== false) return;
    // エンジン停止中の回復検知は可視時のみ。バックグラウンドのポーリングを止め
    // バッテリー・帯域を節約する（他コンポーネントと同じ visibility ガード）。
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [health?.engineOk, refresh]);

  function addImageFiles(files: FileList) {
    if (!canAttachComposerImages({ goalLoopEnabled, submitting })) return;
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
    if ((!prompt.trim() && attachments.length === 0) || projectId === undefined || submitting) return;
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
      const isAuto = model === AUTO_MODEL_VALUE;
      const autoRouteConfig = readAutoRouteConfig();
      const result = await sendJson<{ task: TaskSummary; autoDecision?: AutoDecision }>("/api/tasks", {
        projectId: projectId ?? null,
        prompt,
        // アカウントタグ付きモデルの value は「accountId::provider::model」。送信時は
        // Pi が解釈できる「provider::model」へ戻す（accountId は別フィールドで渡す）。
        ...(!isAuto ? { model: plainModelValue(model, models), thinkingLevel } : {}),
        ...(isAuto
          ? {
              auto: true,
              autoOptimize: autoOptimizeMode,
              autoRouteOverrides: autoRouteConfig,
            }
          : {}),
        images,
        ...(agent ? { agent } : {}),
        ...(selectedModel?.accountId ? { accountId: selectedModel.accountId } : {}),
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
      if (isAuto && result.autoDecision) {
        writeAutoTaskRecord(result.task.id, {
          decision: result.autoDecision,
          ...(!images.length && prompt.length <= AUTO_TASK_PROMPT_MAX ? { prompt } : {}),
          ...(result.task.agent?.trim() ? { agent: result.task.agent.trim() } : {}),
        });
      }
      localStorage.setItem(MODEL_KEY, model);
      writeStoredThinkingLevel(thinkingLevel);
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
                value={projectId ?? ""}
                disabled={submitting}
                aria-label="プロジェクト"
                icon={<FolderGit2 className="h-3.5 w-3.5" />}
                valueLabel={selectedProject ? selectedProject.name : NO_PROJECT_NAME}
                onChange={(value) => setProjectId(value || null)}
                className="min-w-0 max-w-[11rem] shrink sm:max-w-56"
                title={selectedProject?.name ?? NO_PROJECT_NAME}
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
                <option value="">{NO_PROJECT_NAME}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </GhostSelect>
            </div>
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
                  if (!canAttachComposerImages({ goalLoopEnabled, submitting })) return;
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
                inputDisabled: !canAttachComposerImages({ goalLoopEnabled, submitting }),
                buttonDisabled: !canAttachComposerImages({ goalLoopEnabled, submitting }),
                buttonTitle: "画像を添付",
                onFilesSelected: addImageFiles,
                onTrigger: () => fileInputRef.current?.click(),
              }}
              toolbar={
                <>
                  <ModelSelect
                    value={model}
                    disabled={submitting}
                    loading={modelsLoading}
                    options={modelOptions}
                    onChange={(value) => {
                      setModel(value);
                      localStorage.setItem(MODEL_KEY, value);
                    }}
                    className="min-w-0 max-w-[9rem] shrink sm:max-w-48"
                  />
                  {model === AUTO_MODEL_VALUE ? (
                    <AutoOptimizeSelect
                      value={autoOptimizeMode}
                      disabled={submitting}
                      onChange={(value) => {
                        setAutoOptimizeMode(value);
                        writeAutoOptimizeMode(value);
                        void writeAutoSettingToServer(AUTO_OPTIMIZE_SETTING_KEY, value);
                      }}
                    />
                  ) : (
                    <ThinkingSelect
                      levels={thinkingLevels}
                      value={thinkingLevel}
                      disabled={submitting}
                      onChange={(value) => {
                        setThinkingLevel(value);
                        writeStoredThinkingLevel(value);
                      }}
                      className="min-w-0 max-w-[7rem] shrink sm:max-w-[8rem]"
                    />
                  )}
                  {agents.length > 0 && (
                    <AgentSelect
                      value={agent}
                      agents={agents}
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
                  disabled={(!prompt.trim() && attachments.length === 0) || projectId === undefined || submitting || health?.engineOk === false}
                >
                  {!submitting && <ArrowUp className="h-4.5 w-4.5" />}
                </Button>
              }
            />
            <NextTaskSuggest
              projectId={projectId ?? ""}
              model={selectedModel?.value === AUTO_MODEL_VALUE ? undefined : selectedModel}
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

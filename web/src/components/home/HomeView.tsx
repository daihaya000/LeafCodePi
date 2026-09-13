"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, FolderGit2 } from "lucide-react";
import { AddProjectButton } from "@/components/AddProjectButton";
import { AgentSelect } from "@/components/AgentSelect";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import {
  COMPOSER_ACTION_BUTTON_CLASS,
  Composer,
  composerPromptAttachments,
  readComposerFiles,
  type ComposerAttachment,
  type ComposerReference,
} from "@/components/Composer";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { NextTaskSuggest } from "@/components/home/NextTaskSuggest";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { isImeComposingEvent } from "@/lib/composer-ime";
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
import { readCachedModels, writeCachedModels } from "@/lib/models-cache";

const MODEL_KEY = "leafcodepi.defaultModel";

/** プライベートモード等のストレージ例外でもモデル選択を壊さない。 */
function readStoredModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredModel(model: string): void {
  try {
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    /* プライベートモード等では永続できないだけ */
  }
}

/** アカウントタグ付きモデルの value を Pi が解釈できる「provider::model」へ戻す。 */
function plainModelValue(modelValue: string, models: ModelOption[]): string {
  // integrated / 旧アカウント接頭辞も modelOptionForValue で解決し、常に provider::model へ正規化する。
  const option = modelOptionForValue(models, modelValue);
  if (!option) return modelValue;
  return `${option.providerID}::${option.modelID}`;
}

function sameList<T>(
  current: readonly T[] | undefined,
  next: readonly T[] | undefined,
): boolean {
  if (current === next) return true;
  const currentLength = current?.length ?? 0;
  const nextLength = next?.length ?? 0;
  if (currentLength !== nextLength) return false;
  if (currentLength === 0) return true;
  if (!current || !next) return false;
  return current.every((value, index) => value === next[index]);
}

function sameComposerReferences(
  current: readonly ComposerReference[],
  next: readonly ComposerReference[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((reference, index) => {
    const candidate = next[index];
    return reference.name === candidate?.name &&
      reference.description === candidate?.description &&
      sameList(reference.tools, candidate?.tools);
  });
}

function sameModelOptions(
  current: readonly ModelOption[],
  next: readonly ModelOption[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((model, index) => {
    const candidate = next[index];
    return model.value === candidate?.value &&
      model.label === candidate?.label &&
      model.providerID === candidate?.providerID &&
      model.modelID === candidate?.modelID &&
      model.accountId === candidate?.accountId &&
      model.accountLabel === candidate?.accountLabel &&
      sameList(model.input, candidate?.input) &&
      model.reasoning === candidate?.reasoning &&
      sameList(model.thinkingLevels, candidate?.thinkingLevels) &&
      model.codexbarUsedPercent === candidate?.codexbarUsedPercent &&
      model.codexbarIntegratedUsedPercent === candidate?.codexbarIntegratedUsedPercent &&
      model.codexbarLimited === candidate?.codexbarLimited &&
      model.codexbarMaxed === candidate?.codexbarMaxed &&
      model.codexbarStale === candidate?.codexbarStale &&
      model.routingMode === candidate?.routingMode &&
      model.routingCandidateCount === candidate?.routingCandidateCount;
  });
}

export const HomeView = memo(function HomeView({
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
  const [models, setModels] = useState<ModelOption[]>(() => readCachedModels() ?? []);
  const [modelsLoading, setModelsLoading] = useState(() => models.length === 0);
  // キャッシュ hit でも選択値を即復元しないと ModelSelect が「モデルなし」になる。
  const [model, setModel] = useState(() => {
    if (models.length === 0) return "";
    const nextOptions = [AUTO_MODEL_OPTION, ...models];
    return modelOptionForValue(nextOptions, readStoredModel())?.value ?? models[0]?.value ?? "";
  });
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
  const modelsRef = useRef<ModelOption[]>(models);
  const modelRefreshRef = useRef(0);

  const selectedProject = projectId
    ? projects.find((project) => project.id === projectId)
    : undefined;
  const modelOptions = useMemo(() => [AUTO_MODEL_OPTION, ...models], [models]);
  // ModelSelect 表示と同じ照合にし、integrated / 旧アカウント接頭辞でも思考レベルを失わない。
  const selectedModel = modelOptionForValue(modelOptions, model);
  const thinkingLevels = useMemo(
    () => selectedModel?.thinkingLevels ?? [],
    [selectedModel],
  );

  const refresh = useCallback(async () => {
    if (modelsRef.current.length === 0) setModelsLoading(true);
    const refreshId = ++modelRefreshRef.current;
    const modelRequest = getJson<{ models: ModelOption[] }>("/api/models");
    void modelRequest
      .then((result) => {
        if (modelRefreshRef.current !== refreshId) return;
        const nextModels = result.models;
        const previousModels = modelsRef.current;
        if (!sameModelOptions(previousModels, nextModels)) {
          modelsRef.current = nextModels;
          setModels(nextModels);
          writeCachedModels(nextModels);
        }
        const nextOptions = [AUTO_MODEL_OPTION, ...nextModels];
        setModel((current) => {
          const preserved = modelOptionForValue(nextOptions, current);
          if (preserved) return preserved.value;
          const previous = modelOptionForValue(previousModels, current);
          const migrated = previous && modelOptionForValue(nextOptions, previous.value);
          if (migrated) return migrated.value;
          const stored = readStoredModel();
          return modelOptionForValue(nextOptions, stored)?.value ?? nextModels[0]?.value ?? "";
        });
        setModelsLoading(false);
      })
      .catch(() => {
        if (modelRefreshRef.current === refreshId) setModelsLoading(false);
      });

    const [projectRes, healthRes, agentRes, skillRes] = await Promise.allSettled([
      getJson<{ projects: ProjectDto[] }>("/api/projects"),
      getJson<HealthDto>("/api/health"),
      getJson<{ agents: { name: string; description?: string; enabled: boolean; tools?: string[] }[] }>("/api/agents"),
      getJson<{ skills: { name: string; description?: string; enabled: boolean }[] }>("/api/skills"),
    ]);
    if (projectRes.status === "fulfilled") {
      const nextProjects = projectRes.value.projects;
      setProjects((current) =>
        current.length === nextProjects.length &&
        current.every((project, index) =>
          project.id === nextProjects[index]?.id && project.name === nextProjects[index]?.name,
        )
          ? current
          : nextProjects,
      );
      setProjectId((current) => {
        if (current === null) return null;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        return nextProjects[0]?.id ?? null;
      });
    }
    if (healthRes.status === "fulfilled") {
      setHealth((current) => current?.engineOk === healthRes.value.engineOk ? current : healthRes.value);
    }
    if (agentRes.status === "fulfilled") {
      const enabledAgents = agentRes.value.agents
        .filter((a) => a.enabled)
        .map(({ name, description, tools }) => ({ name, description, tools }));
      const enabledAgentNames = enabledAgents.map(({ name }) => name);
      setAgents((current) =>
        sameComposerReferences(current, enabledAgents) ? current : enabledAgents,
      );
      setAgent((current) => resolveAgentSelection(current || readStoredAgent(), enabledAgentNames));
    }
    if (skillRes.status === "fulfilled") {
      const enabledSkills = skillRes.value.skills
        .filter((skill) => skill.enabled)
        .map(({ name, description }) => ({ name, description }));
      setSkills((current) =>
        sameComposerReferences(current, enabledSkills) ? current : enabledSkills,
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

  function addFiles(files: FileList) {
    if (!canAttachComposerImages({ goalLoopEnabled, submitting })) return;
    readComposerFiles(files, (attachment) => {
      setAttachments((current) => [...current, attachment]);
    });
  }

  async function submit() {
    if ((!prompt.trim() && attachments.length === 0) || projectId === undefined || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (goalLoopEnabled && attachments.length > 0) {
        throw new Error("Goal loop の開始ではファイル添付は使えません");
      }
      const { images, files } = composerPromptAttachments(attachments);
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
        files,
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
          ...(!images.length && !files.length && prompt.length <= AUTO_TASK_PROMPT_MAX ? { prompt } : {}),
          ...(result.task.agent?.trim() ? { agent: result.task.agent.trim() } : {}),
        });
      }
      writeStoredModel(model);
      writeStoredThinkingLevel(thinkingLevel);
      notifyTasksChanged();
      router.push(`/task/${result.task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "タスクを開始できません");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-bot-chat">
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
              className="bot-composer-shell relative mx-auto w-full max-w-5xl rounded-3xl border border-bot-outline bg-bot-panel px-2 py-1 transition-colors focus-within:border-bot-outline"
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
                  // 添付不可でも画像ペーストは検出して preventDefault する。
                  // 早期 return すると textarea へ画像が落ちる。
                  if (pasteImage(addFiles, event)) event.preventDefault();
                },
                onCompositionStart: () => {
                  composingRef.current = true;
                },
                onCompositionEnd: () => {
                  composingRef.current = false;
                },
                onBlur: () => {
                  // composition 中にフォーカスが外れると compositionEnd が来ない
                  // ことがあり、stuck true で Ctrl+Enter 送信が永久に無効化される
                  composingRef.current = false;
                },
                onKeyDown: (event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !composingRef.current &&
                    !isImeComposingEvent(event)
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                },
                placeholder: "タスクを説明してください…（Ctrl+Enter で開始）",
                className: "w-full min-h-11 resize-none bg-transparent py-2.5 text-base leading-6 outline-none placeholder:text-faint",
              }}
              references={{ skills, agents }}
              attachmentControl={{
                inputRef: fileInputRef,
                inputDisabled: !canAttachComposerImages({ goalLoopEnabled, submitting }),
                buttonDisabled: !canAttachComposerImages({ goalLoopEnabled, submitting }),
                buttonTitle: "ファイルを添付",
                onFilesSelected: addFiles,
                onTrigger: () => fileInputRef.current?.click(),
              }}
              settingsGroups={[
                {
                  id: "execution",
                  label: "実行設定",
                  content: (
                    <>
                  <ModelSelect
                    value={model}
                    disabled={submitting}
                    loading={modelsLoading}
                    options={modelOptions}
                    onChange={(value) => {
                      setModel(value);
                      writeStoredModel(value);
                    }}
                    className="min-w-0 max-w-[9rem] shrink sm:max-w-48"
                  />
                  {model === AUTO_MODEL_VALUE ? (
                    <AutoOptimizeSelect
                      value={autoOptimizeMode}
                      disabled={submitting}
                      className="h-8 shrink-0"
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
                    </>
                  ),
                },
                {
                  id: "permissions",
                  label: "権限設定",
                  content: (
                    <>
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
                    </>
                  ),
                },
                {
                  id: "continuation",
                  label: "継続実行",
                  content: (
                    <>
                  <GoalLoopToggle
                    enabled={goalLoopEnabled}
                    disabled={submitting}
                    onToggle={() => setGoalLoopEnabled((value) => !value)}
                  />
                    </>
                  ),
                },
              ]}
              action={
                <Button
                  variant="primary"
                  size="icon"
                  type="submit"
                  aria-label="タスク開始"
                  className={`${COMPOSER_ACTION_BUTTON_CLASS} !bg-accent !text-white hover:!bg-accent/90`}
                  busy={submitting}
                  disabled={(!prompt.trim() && attachments.length === 0) || projectId === undefined || submitting || health?.engineOk === false}
                >
                  {!submitting && <ArrowUp className="h-4 w-4" />}
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
});

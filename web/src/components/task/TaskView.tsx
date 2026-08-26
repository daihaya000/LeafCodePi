"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  GitGraph,
  ListPlus,
  PanelRight,
  Plus,
  RotateCcw,
  Shrink,
  Square,
  Zap,
} from "lucide-react";
import { Composer, type ComposerAttachment, type ComposerReference } from "@/components/Composer";
import { CollaborationBadge, CollaborationNotice, useCollaborationRoom } from "@/components/CollaborationStatus";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { pasteImage } from "@/lib/clipboard-image";
import { GoalLoopPanel } from "@/components/GoalLoopPanel";
import { DiffPane } from "@/components/task/DiffPane";
import { NextAction } from "@/components/task/NextAction";
import { GraphPanel } from "@/components/task/GraphPanel";
import { TodoProgressPanel } from "@/components/task/TodoProgressPanel";
import { ModelSelect } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { AgentSelect } from "@/components/AgentSelect";
import { SubagentPermissionSelect } from "@/components/SubagentPermissionSelect";
import { SkillPermissionSelect } from "@/components/SkillPermissionSelect";
import { PermissionSelect } from "@/components/PermissionSelect";
import { StatusBadge } from "@/components/StatusBadge";
import { MobileMenuButton } from "@/components/shell/MobileMenuHeader";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { PartView, WorkingRow } from "@/components/task/PartView";
import { QuestionCard } from "@/components/task/QuestionCard";
import {
  QueuedFollowUpsNotice,
  type QueuedFollowUp,
} from "@/components/task/QueuedFollowUpsNotice";
import { Button, cx, GhostSelect } from "@/components/ui";
import { formatTokens, type ContextUsageDto } from "@/lib/context-usage";
import { formatTokensPerSecond } from "@/lib/token-throughput";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import { writeStoredAgent } from "@/lib/default-agent";
import {
  messageNavigationIds,
  messageNavigationIndex,
} from "@/lib/message-navigation";
import {
  normalizeTaskPanelState,
  toggleTaskPanel,
  type TaskPanelState,
} from "@/lib/mobile-panel-state";
import { clampScrollTop, isNearBottom, nextStickState } from "@/lib/scroll-stick";
import {
  readScrollButtonOpacity,
  subscribeScrollButtonOpacity,
} from "@/lib/scroll-button-opacity";
import {
  messageRenderKey,
  stabilizeUiMessages,
  upsertUiMessage,
} from "@/lib/stabilize-messages";
import {
  loadTaskSessionCache,
  saveTaskSessionCache,
  type TaskSessionCacheSnapshot,
} from "@/lib/task-session-cache";
import {
  findResumableTurn,
  type ResumableTurn,
} from "@/lib/aborted-resume";
import {
  countHangRetryUserMessages,
  isHangRetryUserMessage,
} from "@/lib/hang-retry";
import {
  autoResumePrompt,
  formatHangTimeout,
  readAutoResumeMode,
  readHangTimeoutMs,
  subscribeAutoResumeMode,
} from "@/lib/hang-timeout";
import {
  playAttentionRequiredSound,
  playSessionCompleteSound,
} from "@/lib/session-complete-sound";
import {
  decideNotification,
  notificationText,
} from "@/lib/notify";
import { defaultThinkingLevel, isThinkingLevel, thinkingLevelLabel } from "@/lib/thinking-levels";
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
import type {
  DiffFilesPayload,
  GoalLoopDto,
  ModelOption,
  PermissionRequestDto,
  QuestionRequestDto,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TodoDto,
  ThinkingLevel,
  UiMessage,
} from "@/lib/types";
import { statusFromChangedFileCount, type WorktreeStatus } from "@/lib/worktree-status";

/** Compaction LLM calls routinely exceed the default fetch budget. */
const COMPACT_TIMEOUT_MS = 240_000;

/**
 * スナップショット毎に新オブジェクトが生成される setTask のマージ結果を、
 * 表示影響フィールドの比較で安定化する。contextUsage / goalLoop / todos は
 * サーバー側キャッシュにより不変時は同一参照になるため参照比較で済む。
 */
function sameTaskDetail(a: TaskDetail | null, b: TaskDetail): boolean {
  if (!a) return false;
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.providerID === b.providerID &&
    a.modelID === b.modelID &&
    a.thinkingLevel === b.thinkingLevel &&
    a.error === b.error &&
    a.agent === b.agent &&
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.updatedAt === b.updatedAt &&
    a.isStreaming === b.isStreaming &&
    a.isCompacting === b.isCompacting &&
    a.contextUsage === b.contextUsage &&
    a.goalLoop === b.goalLoop &&
    a.todos === b.todos &&
    a.permissionRequest?.id === b.permissionRequest?.id &&
    a.questionRequest?.id === b.questionRequest?.id
  );
}

function samePermissionRequest(
  a: PermissionRequestDto | null,
  b: PermissionRequestDto | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.command === b.command &&
    a.message === b.message &&
    JSON.stringify(a.labels) === JSON.stringify(b.labels)
  );
}

function sameQuestionRequest(
  a: QuestionRequestDto | null,
  b: QuestionRequestDto | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.sessionId === b.sessionId && JSON.stringify(a.questions) === JSON.stringify(b.questions);
}

const SIDE_PANEL_MIN_WIDTH = 240;
const SIDE_PANEL_MAX_WIDTH = 640;

/** 右側パネル（Graph / Diff）の幅を左端ドラッグで調整できるラッパー。 */
function SidePanel({ storageKey, children }: { storageKey: string; children: React.ReactNode }) {
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= SIDE_PANEL_MIN_WIDTH) {
      setWidth(Math.min(saved, SIDE_PANEL_MAX_WIDTH));
    }
  }, [storageKey]);
  return (
    <div
      className="relative flex h-full min-h-0 shrink-0 flex-col border-b border-border md:h-72 lg:h-auto lg:w-(--panel-width) lg:border-b-0 lg:border-l"
      style={{ "--panel-width": `${width}px` } as React.CSSProperties}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="パネルの幅を調整"
        className="absolute top-0 left-0 hidden h-full w-1 cursor-col-resize lg:block"
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;
          const onMove = (move: PointerEvent) => {
            const next = Math.min(
              SIDE_PANEL_MAX_WIDTH,
              Math.max(SIDE_PANEL_MIN_WIDTH, startWidth - (move.clientX - startX)),
            );
            setWidth(next);
            localStorage.setItem(storageKey, String(next));
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
    </div>
  );
}

function TurnNoticeBanner({
  message,
  action,
  actionError,
  tone = "danger",
}: {
  message: string;
  action?: React.ReactNode;
  actionError?: string | null;
  tone?: "danger" | "neutral";
}) {
  return (
    <div
      className={cx(
        "rounded-lg border px-3 py-2",
        tone === "danger"
          ? "border-danger/30 bg-danger-bg"
          : "border-border bg-surface-2",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p
          className={cx(
            "min-w-0 break-all text-xs",
            tone === "danger" ? "text-danger" : "text-muted",
          )}
        >
          {message}
        </p>
        {action}
      </div>
      {actionError && (
        <p role="alert" className="mt-1.5 break-all text-xs text-danger">
          {actionError}
        </p>
      )}
    </div>
  );
}

function ContextUsageMeter({ usage }: { usage: ContextUsageDto }) {
  const pct = usage.percent;
  const usedLabel = usage.tokens === null ? "?" : formatTokens(usage.tokens);
  const limitLabel = formatTokens(usage.contextWindow);
  const pctLabel = pct === null ? "?" : `${pct}%`;
  const barWidth = pct === null ? 0 : pct;
  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] text-muted"
      title={`コンテキスト使用量: ${usedLabel} / ${limitLabel} トークン（${pctLabel}）`}
    >
      <span className="h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-surface-2 sm:w-10">
        <span
          className={cx(
            "block h-full rounded-full transition-[width]",
            pct === null
              ? "bg-faint"
              : pct >= 90
                ? "bg-danger"
                : pct >= 70
                  ? "bg-warning"
                  : "bg-accent",
          )}
          style={{ width: `${barWidth}%` }}
        />
      </span>
      <span className="hidden font-mono tabular-nums sm:inline">
        {usedLabel}/{limitLabel} ({pctLabel})
      </span>
    </span>
  );
}

export function TaskView({
  taskId,
  active = true,
  onStatus,
  onAddPane,
}: {
  taskId: string;
  /** 非アクティブタブは hidden mount（CSS で非表示、SSE は維持）。 */
  active?: boolean;
  /** SSE snapshot の status 変化をタブバッジへ報告する（TaskPanesProvider）。 */
  onStatus?: (status: TaskStatus) => void;
  /** 1 ペイン時にも分割を開始できるよう空ペインを追加する。 */
  onAddPane?: () => void;
}) {
  const { mdUp } = useTaskPanes();
  const [cachedSession] = useState(() => loadTaskSessionCache(taskId));
  const [task, setTask] = useState<TaskDetail | null>(cachedSession);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>(() => cachedSession?.messages ?? []);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsageDto | undefined>(
    () => cachedSession?.contextUsage,
  );
  const [isCompacting, setIsCompacting] = useState(Boolean(cachedSession?.isCompacting));
  const [compactingLocal, setCompactingLocal] = useState(false);
  const [isReverted, setIsReverted] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const revertEntryRef = useRef<{ messageId: string; message: UiMessage | undefined } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [goalLoopEnabled, setGoalLoopEnabled] = useState(false);
  const [goalLoopAcceptance, setGoalLoopAcceptance] = useState("");
  const [goalLoopMaxTurns, setGoalLoopMaxTurns] = useState(10);
  const [goalLoopCooldownSeconds, setGoalLoopCooldownSeconds] = useState(0);
  const [goalLoopForceFullRun, setGoalLoopForceFullRun] = useState(false);
  const [panelState, setPanelState] = useState<TaskPanelState>({
    graphOpen: false,
    diffOpen: false,
  });
  const { graphOpen, diffOpen } = panelState;
  useEffect(() => {
    setPanelState((current) => normalizeTaskPanelState(current, mdUp));
  }, [mdUp]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<"queue" | "steer">("queue");
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const [queuedAutoSend, setQueuedAutoSend] = useState(false);
  const nextQueueIdRef = useRef(1);
  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  const [submitting, setSubmitting] = useState(false);
  const [resumingTurn, setResumingTurn] = useState(false);
  const [resumeTurnError, setResumeTurnError] = useState<string | null>(null);
  const [manualAbortedAssistantId, setManualAbortedAssistantId] = useState<string | null>(null);
  const autoResumeKeyRef = useRef<string | null>(null);
  const [hangRetryCount, setHangRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionHydrating, setSessionHydrating] = useState(Boolean(cachedSession));
  const [sseReconnecting, setSseReconnecting] = useState(false);
  const [agents, setAgents] = useState<ComposerReference[]>([]);
  const [skills, setSkills] = useState<ComposerReference[]>([]);
  const messageReferences = useMemo(
    () => ({
      skills,
      agents,
    }),
    [agents, skills],
  );
  const [agent, setAgent] = useState("");
  const [subagentPermission, setSubagentPermission] = useState<SubagentPermission>(
    () => readSubagentPermission(),
  );
  const [skillPermission, setSkillPermission] = useState<SkillPermission>(
    () => readSkillPermission(),
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readPermissionMode());
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequestDto | null>(null);
  const [questionRequest, setQuestionRequest] = useState<QuestionRequestDto | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const { room: collaborationRoom, refresh: refreshCollaborationRoom } = useCollaborationRoom(active ? task?.projectId : null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const previousWorkingRef = useRef(false);
  const titleTaskRef = useRef(taskId);
  // メッセージ間をジャンプするナビゲーター（本家 LeafCode と同じ）。
  // 描画済みメッセージ要素と「今どのナビゲーション対象を見ているか」を保持する。
  const messageElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const currentNavigationIdxRef = useRef(0);
  // onScroll の deps を安定させるため、id 一覧を ref にミラーする（本家と同じ）。
  const navigationMessageIdsRef = useRef<string[]>([]);
  // 呼び出し元（TaskPanesHost）は毎レンダーで新しい onStatus 関数を渡すため、
  // そのまま SSE effect の deps に入れると親の再描画ごとに EventSource が
  // 張り直される。latest-ref 経由で呼び、effect を taskId 変化時のみ再接続に限定する。
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);
  // ナビゲーター ボタンの不透明度（設定 → 一般タブで変更可）。
  const [scrollButtonOpacity, setScrollButtonOpacity] = useState(
    () => readScrollButtonOpacity(),
  );
  useEffect(
    () => subscribeScrollButtonOpacity(() => setScrollButtonOpacity(readScrollButtonOpacity())),
    [],
  );
  // 自動再開方法（同じプロンプト再送 / 「続けて」）。手動再開ボタンの文言と
  // 再送内容の両方に反映する。
  const [autoResumeMode, setAutoResumeMode] = useState(readAutoResumeMode);
  useEffect(
    () => subscribeAutoResumeMode(() => setAutoResumeMode(readAutoResumeMode())),
    [],
  );
  const sidebarNotifyKeyRef = useRef("");
  const cacheSnapshotRef = useRef<TaskSessionCacheSnapshot | null>(null);
  const cacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  cacheSnapshotRef.current = task
    ? {
        task,
        messages,
        isStreaming: task.isStreaming,
        isCompacting,
        ...(contextUsage ? { contextUsage } : {}),
      }
    : null;

  useEffect(() => {
    const snapshot = cacheSnapshotRef.current;
    if (!snapshot || (sessionHydrating && snapshot.messages.length === 0)) return;
    // Throttle rather than debounce so a long-running stream is still cached
    // before the host is quit.
    if (cacheTimerRef.current !== null) return;
    cacheTimerRef.current = setTimeout(() => {
      cacheTimerRef.current = null;
      const latest = cacheSnapshotRef.current;
      if (latest) saveTaskSessionCache(latest);
    }, 500);
  }, [contextUsage, isCompacting, messages, sessionHydrating, task, taskId]);

  useEffect(() => {
    const flush = () => {
      if (cacheTimerRef.current !== null) {
        clearTimeout(cacheTimerRef.current);
        cacheTimerRef.current = null;
      }
      const latest = cacheSnapshotRef.current;
      if (latest && !(sessionHydrating && latest.messages.length === 0)) {
        saveTaskSessionCache(latest);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [sessionHydrating, taskId]);

  const applyDetail = useCallback((detail: TaskDetail) => {
    setTask(detail);
    setMessages((prev) => stabilizeUiMessages(prev, detail.messages));
    setContextUsage(detail.contextUsage);
    setIsCompacting(Boolean(detail.isCompacting));
    setSessionHydrating(false);
    setPermissionRequest(detail.permissionRequest ?? null);
    setQuestionRequest(detail.questionRequest ?? null);
    setSkillPermission(detail.skillPermission ?? readSkillPermission());
    // セッション人格は作成時固定。タスクに紐づくエージェントを選択状態へ反映する。
    setAgent((current) => current || detail.agent || "");
  }, []);

  const notifySidebarIfNeeded = useCallback((snapshotTask?: TaskSummary | TaskDetail | null) => {
    if (!snapshotTask) return;
    const key = `${snapshotTask.id}|${snapshotTask.status}|${snapshotTask.title}`;
    if (key === sidebarNotifyKeyRef.current) return;
    sidebarNotifyKeyRef.current = key;
    notifyTasksChanged();
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    sidebarNotifyKeyRef.current = "";
    setManualAbortedAssistantId(null);
    setHangRetryCount(0);
    setResumeTurnError(null);
    setPermissionRequest(null);
    setPermissionBusy(false);
    setSessionHydrating(false);
    setSseReconnecting(false);

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/tasks/${taskId}/events`);
      source.addEventListener("snapshot", (event) => {
        if (closed) return;
        if (retryCount > 0) setError(null);
        setSseReconnecting(false);
        retryCount = 0;
        let payload: {
          task?: TaskDetail;
          messages?: UiMessage[];
          isStreaming?: boolean;
          isCompacting?: boolean;
          contextUsage?: ContextUsageDto;
          goalLoop?: GoalLoopDto | null;
          todos?: TodoDto[];
          error?: string;
          manualAbortedAssistantId?: string | null;
          hangRetryCount?: number;
          permissionRequest?: PermissionRequestDto | null;
          questionRequest?: QuestionRequestDto | null;
          eventType?: string;
        };
        try {
          payload = JSON.parse((event as MessageEvent).data) as typeof payload;
        } catch {
          setError("イベントデータの解析に失敗しました");
          return;
        }
        const snapshotTask = payload.task;
        const isBootstrap = payload.eventType === "bootstrap";
        setSessionHydrating(isBootstrap);
        startTransition(() => {
          if (snapshotTask) {
            setTask((current) => {
              const base = current ?? snapshotTask;
              const keepExistingMessages = isBootstrap &&
                payload.messages?.length === 0 &&
                base.messages.length > 0;
              const next: TaskDetail = {
                ...base,
                ...snapshotTask,
                messages: keepExistingMessages
                  ? base.messages
                  : payload.messages ?? base.messages ?? [],
                isStreaming: payload.isStreaming ?? snapshotTask.isStreaming ?? base.isStreaming,
                isCompacting: payload.isCompacting ?? snapshotTask.isCompacting ?? base.isCompacting,
                contextUsage: payload.contextUsage ?? snapshotTask.contextUsage ?? base.contextUsage,
                goalLoop: payload.goalLoop ?? snapshotTask.goalLoop ?? base.goalLoop,
                todos: payload.todos ?? snapshotTask.todos ?? base.todos,
              };
              // 表示に影響しないスナップショット（tool実行中のメッセージ進捗等）は
              // 参照を維持し、TaskView 全体の再レンダーを防ぐ。
              return sameTaskDetail(current, next) ? current : next;
            });
          }
          if (payload.messages && (!isBootstrap || payload.messages.length > 0)) {
            setMessages((prev) => stabilizeUiMessages(prev, payload.messages!));
          }
          if ("contextUsage" in payload) {
            setContextUsage((current) =>
              current === payload.contextUsage ? current : payload.contextUsage,
            );
          }
          if ("isCompacting" in payload) setIsCompacting(Boolean(payload.isCompacting));
          if ("manualAbortedAssistantId" in payload) {
            setManualAbortedAssistantId(payload.manualAbortedAssistantId ?? null);
          }
          if (typeof payload.hangRetryCount === "number") {
            setHangRetryCount(payload.hangRetryCount);
          }
          if ("permissionRequest" in payload) {
            setPermissionRequest((current) =>
              samePermissionRequest(current, payload.permissionRequest ?? null)
                ? current
                : payload.permissionRequest ?? null,
            );
          }
          if ("questionRequest" in payload) {
            setQuestionRequest((current) =>
              sameQuestionRequest(current, payload.questionRequest ?? null)
                ? current
                : payload.questionRequest ?? null,
            );
          }
        });
        if (payload.error) setError(payload.error);
        notifySidebarIfNeeded(snapshotTask);
        const status = snapshotTask?.status;
        if (status) onStatusRef.current?.(status);
      });
      source.addEventListener("delta", (event) => {
        if (closed) return;
        let payload: {
          task?: TaskSummary;
          message?: UiMessage | null;
          isStreaming?: boolean;
          isCompacting?: boolean;
          contextUsage?: ContextUsageDto;
        };
        try {
          payload = JSON.parse((event as MessageEvent).data) as typeof payload;
        } catch {
          setError("イベントデータの解析に失敗しました");
          return;
        }
        startTransition(() => {
          if (payload.task) {
            setTask((current) => {
              if (!current) {
                return {
                  ...payload.task!,
                  messages: [],
                  isStreaming: payload.isStreaming ?? payload.task!.status === "working",
                  isCompacting: Boolean(payload.isCompacting),
                };
              }
              const next: TaskDetail = {
                ...current,
                ...payload.task,
                isStreaming: payload.isStreaming ?? current.isStreaming,
                isCompacting: payload.isCompacting ?? current.isCompacting,
                contextUsage: payload.contextUsage ?? current.contextUsage,
              };
              return sameTaskDetail(current, next) ? current : next;
            });
          }
          if (payload.message) {
            setMessages((prev) => upsertUiMessage(prev, payload.message!));
          }
          if ("contextUsage" in payload) {
            setContextUsage((current) =>
              current === payload.contextUsage ? current : payload.contextUsage,
            );
          }
          if ("isCompacting" in payload) setIsCompacting(Boolean(payload.isCompacting));
        });
        notifySidebarIfNeeded(payload.task);
        if (payload.task?.status) onStatusRef.current?.(payload.task.status);
      });
      source.addEventListener("error", (event) => {
        if (closed) return;
        if (event instanceof MessageEvent && typeof event.data === "string") {
          closed = true;
          setSseReconnecting(false);
          source?.close();
          source = null;
          if (retryTimer) clearTimeout(retryTimer);
          try {
            const payload = JSON.parse(event.data) as { error?: string };
            setError(payload.error ?? "イベント接続に失敗しました");
          } catch {
            setError("イベント接続に失敗しました");
          }
          return;
        }
        setSseReconnecting(true);
        setError(null);
        // Auto-reconnect: close the broken stream and retry with backoff.
        source?.close();
        source = null;
        retryCount += 1;
        const delay = Math.min(1000 * 2 ** (retryCount - 1), 15000);
        retryTimer = setTimeout(connect, delay);
      });
    };

    // The SSE endpoint sends the initial full snapshot; avoid a duplicate task-detail request.
    connect();

    void getJson<{ models: ModelOption[] }>("/api/models").then((result) => {
      if (!closed) setModels(result.models);
    }).catch(() => {
      /* models are optional for the timeline */
    });
    void getJson<{ agents: { name: string; description?: string; enabled: boolean }[] }>("/api/agents").then((result) => {
      if (!closed) {
        const enabledAgents = result.agents
          .filter((a) => a.enabled)
          .map(({ name, description }) => ({ name, description }));
        const enabledAgentNames = enabledAgents.map(({ name }) => name);
        setAgents(enabledAgents);
        setAgent((current) => (current && enabledAgentNames.includes(current) ? current : ""));
      }
    }).catch(() => {
      /* agents are optional for the composer */
    });
    void getJson<{ skills: { name: string; description?: string; enabled: boolean }[] }>("/api/skills").then((result) => {
      if (!closed) {
        setSkills(
          result.skills
            .filter((skill) => skill.enabled)
            .map(({ name, description }) => ({ name, description })),
        );
      }
    }).catch(() => {
      /* skills are optional for the composer */
    });
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [taskId, applyDetail, notifySidebarIfNeeded]);

  const scrollToBottom = useCallback((el: HTMLElement) => {
    el.scrollTo({
      top: clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight),
      behavior: "auto",
    });
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (!stickRef.current) return;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el || !stickRef.current) return;
      scrollToBottom(el);
    });
  }, [scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    stickRef.current = nextStickState(stickRef.current, el.scrollTop, prevTop, atBottom);
    // ビューポート上端に来ているナビゲーション対象を追跡し、前後ジャンプの
    // 基準にする（本家と同じ incremental スキャン）。
    const ids = navigationMessageIdsRef.current;
    if (ids.length > 0 && messageElsRef.current.size > 0) {
      const line = el.scrollTop + 4;
      currentNavigationIdxRef.current = messageNavigationIndex(
        ids.length,
        currentNavigationIdxRef.current,
        line,
        (index) => messageElsRef.current.get(ids[index]!)?.offsetTop ?? Number.POSITIVE_INFINITY,
      );
    }
  }, []);

  // 指定インデックスのナビゲーション対象へスムーズスクロールする。
  // id 一覧は後段で宣言されるため ref 経由で参照する（本家と同じ TDZ 回避）。
  const jumpToMessage = useCallback((index: number) => {
    const el = scrollRef.current;
    const targetEl = messageElsRef.current.get(navigationMessageIdsRef.current[index]);
    if (!el || !targetEl) return;
    const line = el.scrollTop + 4;
    const targetTop = el.scrollTop + targetEl.offsetTop - line;
    el.scrollTo({
      top: clampScrollTop(targetTop, el.clientHeight, el.scrollHeight),
      behavior: "smooth",
    });
    currentNavigationIdxRef.current = index;
    stickRef.current = false;
  }, []);

  // 最新位置（タイムライン最下部）へ戻り、追従モードを復帰する。
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight),
      behavior: "smooth",
    });
    currentNavigationIdxRef.current = Math.max(0, navigationMessageIdsRef.current.length - 1);
    stickRef.current = true;
  }, []);

  useEffect(() => {
    stickRef.current = true;
    lastScrollTopRef.current = 0;
    setIsReverted(false);
    setRevertConfirmOpen(false);
    revertEntryRef.current = null;
    setQueuedFollowUps([]);
    setQueuedAutoSend(false);
  }, [taskId]);

  useEffect(() => {
    scheduleScrollToBottom();
  }, [messages, task?.isStreaming, isCompacting, scheduleScrollToBottom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    lastScrollTopRef.current = scroller.scrollTop;
    const pinned = () => {
      if (!stickRef.current) return;
      if (isNearBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)) return;
      scheduleScrollToBottom();
    };
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(pinned);
      observer.observe(content);
      pinned();
      return () => observer.disconnect();
    }
    const id = window.setInterval(pinned, 200);
    return () => window.clearInterval(id);
  }, [scheduleScrollToBottom, taskId]);

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

  const compacting = isCompacting || compactingLocal;
  const working = Boolean(task?.status === "working" || task?.isStreaming);

  // PartView は memo 化されており onRevert の参照比較でスキップ判定する。
  // inline arrow のままだと毎レンダー新参照になり、stabilizeUiMessages の
  // 参照安定化が無効化されるため useCallback で安定させる。
  const requestRevert = useCallback(
    (target: UiMessage) => {
      if (working) {
        setError("実行中は巻き戻せません。停止してからお試しください");
        return;
      }
      revertEntryRef.current = { messageId: target.id, message: target };
      setRevertConfirmOpen(true);
    },
    [working],
  );
  const goalLoopLive = Boolean(
    task?.goalLoop && ["queued", "running", "verifying_completed"].includes(task.goalLoop.status),
  );

  useEffect(() => {
    if (!active || !task?.directory) return;
    let closed = false;
    let inFlight = false;
    const refreshWorktreeStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const payload = await getJson<DiffFilesPayload>("/api/diff/files", {
          directory: task.directory,
          count: "1",
        });
        if (closed) return;
        if (payload.error) {
          setWorktreeStatus(null);
          return;
        }
        // count モードは git status の行数だけ返す（diff パース・untracked 読込なし）。
        const changed = payload.count ?? payload.files.length;
        const next = statusFromChangedFileCount(changed);
        setWorktreeStatus(next);
        onStatusRef.current?.(working ? "working" : task.status === "idle" ? next : task.status);
      } catch {
        if (!closed) setWorktreeStatus(null);
      } finally {
        inFlight = false;
      }
    };

    setWorktreeStatus(null);
    void refreshWorktreeStatus();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshWorktreeStatus();
    }, 4_000);
    return () => {
      closed = true;
      window.clearInterval(timer);
    };
  }, [active, task?.directory, task?.status, working]);

  useEffect(() => {
    if (titleTaskRef.current !== taskId) {
      titleTaskRef.current = taskId;
      previousWorkingRef.current = false;
    }
    const wasWorking = previousWorkingRef.current;
    previousWorkingRef.current = working;
    if (!wasWorking || working || !task?.sessionId) return;
    void sendJson<{ title: string; task: TaskSummary }>(`/api/tasks/${taskId}/title`, {}).then((result) => {
      setTask((current) => (current ? { ...current, title: result.title } : current));
      notifyTasksChanged();
    }).catch(() => undefined);
  }, [task?.sessionId, taskId, working]);

  // 巻き戻し対象候補: 末尾のユーザーメッセージ。末尾が user なら直前の user へ
  // フォールバック（最後まで巻き戻せる状態を保つ）。
  const lastUserMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && message.role === "user") return message;
    }
    return undefined;
  }, [messages]);

  async function revert() {
    const target = revertEntryRef.current;
    if (!target || revertBusy || working) return;
    setRevertBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskDetail; text: string; images: ComposerAttachment[] }>(
        `/api/tasks/${taskId}/revert`,
        { entryId: target.messageId },
      );
      setIsReverted(true);
      if (target.message) {
        setPrompt(
          target.message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n\n"),
        );
        setAttachments((current) => [
          ...current,
          ...result.images.filter(
            (image) => !current.some((item) => item.uri === image.uri),
          ),
        ]);
      }
      applyDetail(result.task);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "巻き戻しに失敗しました");
    } finally {
      setRevertBusy(false);
      setRevertConfirmOpen(false);
      revertEntryRef.current = null;
    }
  }

  async function unrevert() {
    if (revertBusy) return;
    setRevertBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskDetail }>(
        `/api/tasks/${taskId}/unrevert`,
        {},
      );
      setIsReverted(false);
      applyDetail(result.task);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "巻き戻しの取り消しに失敗しました");
    } finally {
      setRevertBusy(false);
    }
  }

  async function submit() {
    if ((!prompt.trim() && attachments.length === 0) || submitting || compacting) return;
    if (working && deliveryMode === "queue") {
      setQueuedFollowUps((current) => [
        ...current,
        {
          id: nextQueueIdRef.current++,
          text: prompt,
          attachments,
        },
      ]);
      setPrompt("");
      setAttachments([]);
      setError(null);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const images = attachments
        .map((attachment) => {
          const comma = attachment.uri.indexOf(",");
          if (comma < 0) return null;
          return { mimeType: attachment.mime, data: attachment.uri.slice(comma + 1) };
        })
        .filter((item): item is { mimeType: string; data: string } => item !== null);
      if (goalLoopEnabled) {
        if (images.length > 0) throw new Error("Goal loop の開始では画像添付は使えません");
        await sendJson(`/api/tasks/${taskId}/goal-loop`, {
          action: "start",
          goal: prompt,
          acceptance: goalLoopAcceptance,
          maxTurns: goalLoopMaxTurns,
          cooldownSeconds: goalLoopCooldownSeconds,
          forceFullRun: goalLoopForceFullRun,
        });
        setGoalLoopEnabled(false);
      } else {
        await sendJson(`/api/tasks/${taskId}/prompt`, {
          prompt,
          images,
          ...(agent ? { agent } : {}),
          subagentPermission,
          permissionMode,
          skillPermission,
          ...(working && deliveryMode === "steer" ? { streamingBehavior: "steer" } : {}),
        });
      }
      setPrompt("");
      setAttachments([]);
      setIsReverted(false);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }
  submitRef.current = submit;

  useEffect(() => {
    if (working || submitting || queuedAutoSend || goalLoopEnabled || goalLoopLive) return;
    const next = queuedFollowUps[0];
    if (!next) return;
    setQueuedFollowUps((current) => current.filter((item) => item.id !== next.id));
    setPrompt(next.text);
    setAttachments(next.attachments);
    setQueuedAutoSend(true);
  }, [goalLoopEnabled, goalLoopLive, queuedAutoSend, queuedFollowUps, submitting, working]);

  useEffect(() => {
    if (!queuedAutoSend || working || submitting || goalLoopEnabled || goalLoopLive) return;
    if (!prompt.trim() && attachments.length === 0) {
      setQueuedAutoSend(false);
      return;
    }
    setQueuedAutoSend(false);
    void submitRef.current();
  }, [attachments.length, goalLoopEnabled, goalLoopLive, prompt, queuedAutoSend, submitting, working]);

  async function goalLoopAction(action: "pause" | "resume" | "stop" | "complete", maxTurns?: number) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendJson<{ loop: GoalLoopDto | null }>(
        `/api/tasks/${taskId}/goal-loop`,
        { action, ...(maxTurns !== undefined ? { maxTurns } : {}) },
        "PATCH",
      );
      setTask((current) => (current ? { ...current, goalLoop: result.loop } : current));
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Goal loop の操作に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  async function compact() {
    if (compacting) return;
    setCompactingLocal(true);
    setIsCompacting(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskDetail }>(
        `/api/tasks/${taskId}/compact`,
        {},
        "POST",
        { timeoutMs: COMPACT_TIMEOUT_MS },
      );
      applyDetail(result.task);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "コンテキスト圧縮に失敗しました");
    } finally {
      setCompactingLocal(false);
    }
  }

  async function abortCompact() {
    try {
      const result = await sendJson<{ task: TaskDetail }>(
        `/api/tasks/${taskId}/compact/abort`,
        {},
      );
      applyDetail(result.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮のキャンセルに失敗しました");
    }
  }

  async function abortWorking() {
    try {
      setError(null);
      const result = await sendJson<{ task: TaskSummary }>(`/api/tasks/${taskId}/abort`, {});
      setTask((current) => (current ? { ...current, ...result.task } : current));
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "停止に失敗しました");
    }
  }

  const resumeTurn = useCallback(async (target: ResumableTurn) => {
    if (working || resumingTurn) return;
    setResumeTurnError(null);
    setResumingTurn(true);
    stickRef.current = true;
    try {
      const resumeMode = readAutoResumeMode();
      const images = resumeMode === "continue"
        ? []
        : target.files
            .map((file) => {
              const comma = file.uri.indexOf(",");
              if (comma < 0) return null;
              return { mimeType: file.mime, data: file.uri.slice(comma + 1) };
            })
            .filter((item): item is { mimeType: string; data: string } => item !== null);
      await sendJson(`/api/tasks/${taskId}/prompt`, {
        prompt: autoResumePrompt(resumeMode, target.text),
        images,
        ...(target.model
          ? { model: `${target.model.providerID}::${target.model.modelID}` }
          : {}),
        subagentPermission,
        permissionMode,
      });
      setManualAbortedAssistantId(null);
      notifyTasksChanged();
    } catch (err) {
      setResumeTurnError(err instanceof Error ? err.message : "再開に失敗しました");
    } finally {
      setResumingTurn(false);
    }
  }, [permissionMode, resumingTurn, subagentPermission, taskId, working]);

  const modelValue =
    task?.providerID && task.modelID ? `${task.providerID}::${task.modelID}` : models[0]?.value ?? "";
  const selectedModel = models.find((option) => option.value === modelValue);
  const thinkingLevels = useMemo(
    () => selectedModel?.thinkingLevels ?? (["off"] as ThinkingLevel[]),
    [selectedModel],
  );
  const thinkingValue: ThinkingLevel = isThinkingLevel(task?.thinkingLevel) && thinkingLevels.includes(task.thinkingLevel)
    ? task.thinkingLevel
    : defaultThinkingLevel(thinkingLevels);
  // --- 通知音・デスクトップ通知（本家 LeafCode から移植） ---
  const attention = permissionRequest !== null || questionRequest !== null;
  // 完了音：working → idle の立下りエッジ。初回マウント時の既定値は実状で
  // 初期化し、既に走っていたターンの完了でも鳴る（本家と同じ挙動）。
  const prevWorkingSoundRef = useRef(working);
  useEffect(() => {
    if (prevWorkingSoundRef.current && !working) playSessionCompleteSound();
    prevWorkingSoundRef.current = working;
  }, [working]);
  // 注意音：承認 UI の立上がりエッジ。タブの可視状態に関係なく鳴らす。
  const prevAttentionSoundRef = useRef(false);
  useEffect(() => {
    if (!prevAttentionSoundRef.current && attention) playAttentionRequiredSound();
    prevAttentionSoundRef.current = attention;
  }, [attention]);

  // デスクトップ通知。document.hidden を state 化するのは、visibilitychange
  // でエフェクトを再実行させ、タブ非表示の瞬間の遷移を見落とさないため。
  const [documentHidden, setDocumentHidden] = useState(() =>
    typeof document !== "undefined" ? document.hidden : false,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => setDocumentHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  // requestPermission() 解決後に effect を再評価させるための tick。
  const [permissionTick, setPermissionTick] = useState(0);
  // requestPermission の多重発呼防止。
  const permissionRequestedRef = useRef(false);
  // 権限が「未許可」の間に検出したエッジの覚え書き。プロンプト回答後に発火。
  const pendingKindRef = useRef<ReturnType<typeof decideNotification>>(null);
  const prevAttentionNotifyRef = useRef(false);
  const prevWorkingNotifyRef = useRef(working);
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    const permission = Notification.permission;

    if (
      permission === "default" &&
      (working || attention) &&
      !permissionRequestedRef.current
    ) {
      permissionRequestedRef.current = true;
      void Notification.requestPermission()
        .catch(() => undefined)
        .then(() => {
          permissionRequestedRef.current = false;
          setPermissionTick((n) => n + 1);
        });
    }

    // エッジは権限の有無にかかわらず検出し、prev 系 ref を実状に保つ
    // （権限未決の間の遷移を握りつぶさない）。
    const edgeKind = decideNotification({
      prevAttention: prevAttentionNotifyRef.current,
      attention,
      prevWorking: prevWorkingNotifyRef.current,
      working,
      documentHidden,
      permission: "granted",
    });
    prevAttentionNotifyRef.current = attention;
    prevWorkingNotifyRef.current = working;
    if (edgeKind) pendingKindRef.current = edgeKind;

    if (permission === "granted" && pendingKindRef.current) {
      const { title, body } = notificationText(pendingKindRef.current, task?.title ?? "");
      try {
        new Notification(title, { body, tag: `task-${task?.id ?? "x"}` });
      } catch {
        // 生成エラー（非対応コンテキスト等）は無視。
      }
      pendingKindRef.current = null;
    }
  }, [
    working,
    attention,
    task?.title,
    task?.id,
    documentHidden,
    permissionTick,
  ]);
  const visibleMessages = useMemo(
    () => messages.filter((message) => !isHangRetryUserMessage(message)),
    [messages],
  );
  const resumeTarget = useMemo(
    () =>
      findResumableTurn(visibleMessages, {
        manualAbortedAssistantId,
      }),
    [visibleMessages, manualAbortedAssistantId],
  );
  const currentPromptIsHangRetry = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") return isHangRetryUserMessage(message);
    }
    return false;
  }, [messages]);
  const showResume =
    !!resumeTarget &&
    !!task &&
    !working &&
    !goalLoopLive;
  useEffect(() => {
    if (
      !showResume ||
      resumeTarget?.reason !== "silent" ||
      task?.status !== "idle" ||
      resumingTurn ||
      currentPromptIsHangRetry
    ) {
      return;
    }
    const key = `${taskId}:${resumeTarget.messageId}`;
    if (autoResumeKeyRef.current === key) return;
    autoResumeKeyRef.current = key;
    void resumeTurn(resumeTarget);
  }, [currentPromptIsHangRetry, resumeTarget, resumeTurn, resumingTurn, showResume, task?.status, taskId]);
  const resumeMessage = resumeTarget
    ? visibleMessages.find((message) => message.id === resumeTarget.messageId)
    : undefined;
  const resumeErrorText = resumeTarget ? resumeMessage?.error ?? "" : "";
  const resumeInsideExistingBanner =
    !!resumeTarget &&
    resumeTarget.reason === "aborted" &&
    !!resumeErrorText &&
    visibleMessages.some((message) => message.id === resumeTarget.messageId);
  const resumeBannerText =
    resumeTarget?.reason === "silent"
      ? "応答がありませんでした"
      : resumeErrorText || "Aborted";
  const resumeAction =
    showResume && resumeTarget ? (
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        aria-label={
          resumeTarget.reason === "silent"
            ? "無言終了したターンを再開"
            : "中断したターンを再開"
        }
        title={
          autoResumeMode === "continue"
            ? "「続けて」を送信して再開します（設定 → ハング判定の自動再開方法に従います）"
            : "直前のプロンプトを同じ内容で再送します"
        }
        busy={resumingTurn}
        disabled={resumingTurn}
        onClick={() => void resumeTurn(resumeTarget)}
      >
        {!resumingTurn && <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />}
        {resumingTurn ? "再開中…" : "再開"}
      </Button>
    ) : null;
  const autoHangRetryCount = useMemo(
    () => Math.max(hangRetryCount, countHangRetryUserMessages(messages)),
    [hangRetryCount, messages],
  );
  const hangRetryNotice =
    autoHangRetryCount > 0
      ? `応答が${formatHangTimeout(readHangTimeoutMs())}間止まったため自動的に停止し、設定した方法で再開しました${
          autoHangRetryCount > 1 ? `（${autoHangRetryCount}回）` : ""
        }`
      : null;
  const modelLabels = useMemo(
    () => Object.fromEntries(models.map((option) => [option.value, option.label])),
    [models],
  );
  // 本家 LeafCode と同じく、メタ行の effort はタスクの現在値を表示する。
  const effortLabel =
    thinkingLevels.length > 1 ? thinkingLevelLabel(thinkingValue) : undefined;

  // ナビゲーターのジャンプ対象: ユーザーメッセージを優先し、Goal Loop の
  // hidden custom message しかない履歴では投影済みメッセージへフォールバックする。
  const userMessageIds = useMemo(
    () => visibleMessages.filter((message) => message.role === "user").map((message) => message.id),
    [visibleMessages],
  );
  const navigationMessageIds = useMemo(
    () => messageNavigationIds(visibleMessages),
    [visibleMessages],
  );
  const navigationTargetLabel = userMessageIds.length > 0 ? "ユーザーメッセージ" : "メッセージ";
  navigationMessageIdsRef.current = navigationMessageIds;
  currentNavigationIdxRef.current = navigationMessageIds.length > 0
    ? Math.min(Math.max(currentNavigationIdxRef.current, 0), navigationMessageIds.length - 1)
    : 0;

  // ヘッダー表示用の会話統計: 合計出力 tok / 平均 tok/s / 合計生成時間。
  const stats = useMemo(() => {
    let totalTokens = 0;
    let rateSum = 0;
    let rateCount = 0;
    let durationMs = 0;
    let prevCreatedAt: number | null = null;
    for (const message of messages) {
      if (message.role === "user" || message.role === "compaction") continue;
      if (typeof message.outputTokens === "number" && message.outputTokens > 0) {
        totalTokens += message.outputTokens;
      }
      if (typeof message.tokensPerSecond === "number" && message.tokensPerSecond > 0) {
        rateSum += message.tokensPerSecond;
        rateCount += 1;
      }
      if (prevCreatedAt !== null) {
        durationMs += Math.max(0, message.createdAt - prevCreatedAt);
      }
      prevCreatedAt = message.createdAt;
    }
    const avgRate = rateCount > 0 ? rateSum / rateCount : null;
    return {
      totalTokens,
      avgRate,
      durationMs: messages.length > 1 ? durationMs : 0,
    };
  }, [messages]);

  function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  const displayedStatus = task
    ? working
      ? "working"
      : task.status === "idle" && worktreeStatus
        ? worktreeStatus
        : task.status
    : null;
  const mobilePanelOpen = !mdUp && (graphOpen || diffOpen);

  return (
    // min-h-0 flex-1: ペイン section が TaskTabs を持つ場合でも残り高さに収める。
    // h-full だとタブバー分だけはみ出し composer 下端が overflow-hidden で欠ける。
    <div className={cx("flex min-h-0 min-w-0 flex-1 flex-col", !active && "hidden")}>
      <header
        className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 md:px-4 md:gap-3"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <MobileMenuButton />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{task?.title ?? "読み込み中…"}</h1>
          {/* Mobile-only compact meta row: the sm:flex row below is hidden
              below sm, so phones would otherwise show no status/context. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-faint sm:hidden">
            {displayedStatus && <StatusBadge status={displayedStatus} />}
            {contextUsage && <ContextUsageMeter usage={contextUsage} />}
            <CollaborationBadge
              projectId={task?.projectId}
              room={collaborationRoom ?? undefined}
              className="sm:hidden"
              onResolved={() => void refreshCollaborationRoom()}
            />
          </div>
          <div className="mt-0.5 hidden min-w-0 items-center gap-1 text-xs text-faint sm:flex">
            {displayedStatus && <StatusBadge status={displayedStatus} />}
            {task?.projectName && (
              <>
                <span className="mx-1 shrink-0">·</span>
                <span className="truncate">{task.projectName}</span>
              </>
            )}
            {contextUsage && (
              <>
                <span className="mx-1 shrink-0">·</span>
                <ContextUsageMeter usage={contextUsage} />
              </>
            )}
            {stats.totalTokens > 0 && (
              <>
                <span className="mx-1 shrink-0">·</span>
                <span
                  className="shrink-0 font-mono tabular-nums"
                  title={`合計 ${formatTokens(stats.totalTokens)} tok（出力のみ）`}
                >
                  {formatTokens(stats.totalTokens)} tok
                </span>
              </>
            )}
            {stats.avgRate !== null && (
              <>
                <span className="mx-1 shrink-0">·</span>
                <span
                  className="shrink-0 font-mono tabular-nums"
                  title="平均 tok/s（応答ごとの tok/s の平均）"
                >
                  {formatTokensPerSecond(stats.avgRate)}
                </span>
              </>
            )}
            {stats.durationMs > 0 && (
              <>
                <span className="mx-1 shrink-0">·</span>
                <span
                  className="shrink-0 font-mono tabular-nums"
                  title="合計生成時間（メッセージ間隔の累計）"
                >
                  {formatDuration(stats.durationMs)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="relative flex min-w-0 shrink-0 items-center gap-1">
          <CollaborationBadge
            projectId={task?.projectId}
            room={collaborationRoom ?? undefined}
            className="hidden sm:inline-flex"
            onResolved={() => void refreshCollaborationRoom()}
          />
          {onAddPane && (
            <Button
              variant="ghost"
              size="icon"
              title="新しいペインを追加"
              aria-label="新しいペインを追加"
              className="h-11 w-11 md:h-9 md:w-9"
              onClick={onAddPane}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
          <div
            role="group"
            aria-label="タスク操作"
            tabIndex={0}
            className="flex max-w-[52vw] items-center gap-1 overflow-x-auto rounded-md [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:max-w-none sm:overflow-visible"
          >
            <Button
              variant="ghost"
              size="icon"
              title="コンテキスト圧縮"
              aria-label="コンテキスト圧縮"
              busy={compacting}
              disabled={!task || working || compacting}
              className="h-11 w-11 md:h-9 md:w-9"
              onClick={() => void compact()}
            >
              {!compacting && <Shrink className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title={isReverted ? "巻き戻しを取消" : "巻き戻す (undo)"}
              aria-label={isReverted ? "巻き戻しを取消" : "巻き戻す"}
              busy={revertBusy}
              aria-pressed={isReverted}
              disabled={!task || !(isReverted || lastUserMessage) || working || compacting}
              className={cx(
                "h-11 w-11 md:h-9 md:w-9",
                isReverted && "bg-surface-2 text-text",
              )}
              onClick={() => {
                if (isReverted) {
                  void unrevert();
                  return;
                }
                if (!lastUserMessage) return;
                revertEntryRef.current = {
                  messageId: lastUserMessage.id,
                  message: lastUserMessage,
                };
                setRevertConfirmOpen(true);
              }}
            >
              {!revertBusy && <RotateCcw className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="コミットグラフ"
              aria-label="コミットグラフ"
              aria-pressed={graphOpen}
              disabled={!task}
              className={cx(
                "h-11 w-11 md:h-9 md:w-9",
                graphOpen && "bg-surface-2 text-text",
              )}
              onClick={() =>
                setPanelState((current) => toggleTaskPanel(current, "graph", mdUp))
              }
            >
              <GitGraph className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Diff パネル"
              aria-label="Diff パネル"
              aria-pressed={diffOpen}
              disabled={!task}
              className={cx(
                "h-11 w-11 md:h-9 md:w-9",
                diffOpen && "bg-surface-2 text-text",
              )}
              onClick={() =>
                setPanelState((current) => toggleTaskPanel(current, "diff", mdUp))
              }
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      {collaborationRoom && (collaborationRoom.leaseConflicts > 0 || collaborationRoom.pendingAsks > 0 || !collaborationRoom.ready) && (
        <div
          className={cx(
            "shrink-0 border-b border-warning/40 bg-warning-bg px-3 py-2 md:px-4",
            mobilePanelOpen && "hidden",
          )}
        >
          <CollaborationNotice
            projectId={active ? task?.projectId : null}
            room={collaborationRoom}
            onResolved={() => void refreshCollaborationRoom()}
          />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cx(
            "min-h-0 min-w-0 flex-1 overscroll-y-contain overflow-x-clip overflow-y-auto px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-4",
            mobilePanelOpen && "hidden",
          )}
        >
          <div ref={contentRef} className="relative mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4">
            {hangRetryNotice && (
              <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                {hangRetryNotice}
              </p>
            )}
            {visibleMessages.map((message) => (
              <div
                key={messageRenderKey(message)}
                ref={(el) => {
                  if (el) messageElsRef.current.set(message.id, el);
                  else messageElsRef.current.delete(message.id);
                }}
              >
                {showResume &&
                resumeInsideExistingBanner &&
                resumeTarget?.messageId === message.id ? (
                  <TurnNoticeBanner
                    message={resumeBannerText}
                    action={resumeAction}
                    actionError={resumeTurnError}
                    tone="danger"
                  />
                ) : (
                  <PartView
                    message={message}
                    modelLabel={
                      message.provider && message.model
                        ? modelLabels[`${message.provider}::${message.model}`]
                        : undefined
                    }
                    effort={message.role === "assistant" ? effortLabel : undefined}
                    agent={message.role === "assistant" ? task?.agent ?? undefined : undefined}
                    references={messageReferences}
                    taskId={taskId}
                    onRevert={message.role === "user" ? requestRevert : undefined}
                  />
                )}
              </div>
            ))}
            {showResume && !resumeInsideExistingBanner && resumeTarget && (
              <TurnNoticeBanner
                message={resumeBannerText}
                action={resumeAction}
                actionError={resumeTurnError}
                tone={resumeTarget.reason === "silent" ? "neutral" : "danger"}
              />
            )}
            {working && <WorkingRow messages={visibleMessages} />}
            {task?.todos && <TodoProgressPanel todos={task.todos} />}
            {visibleMessages.length === 0 && (
              <p
                className="py-12 text-center text-sm text-muted"
                role={sessionHydrating ? "status" : undefined}
                aria-live={sessionHydrating ? "polite" : undefined}
              >
                {sessionHydrating ? "セッションを準備しています…" : "メッセージはまだありません"}
              </p>
            )}
          </div>
        </div>
        {/* メッセージ間を移動するナビゲーター（本家 LeafCode と同じ）。
            設定した不透明度で常時表示し、ホバー・フォーカス時だけ不透明になる。 */}
        {!mobilePanelOpen && navigationMessageIds.length > 0 && (
          <div className="absolute right-4 bottom-4 z-50 flex flex-col gap-2">
            {(
              [
                [`最初の${navigationTargetLabel}へ`, () => jumpToMessage(0), <ChevronsUp key="i" className="h-4 w-4" />],
                [
                  `一つ前の${navigationTargetLabel}へ`,
                  () => {
                    const target = currentNavigationIdxRef.current - 1;
                    jumpToMessage(target >= 0 ? target : 0);
                  },
                  <ChevronUp key="i" className="h-4 w-4" />,
                ],
                [
                  `一つ後の${navigationTargetLabel}へ`,
                  () => {
                    const target = currentNavigationIdxRef.current + 1;
                    if (target >= navigationMessageIdsRef.current.length) {
                      jumpToLatest();
                      return;
                    }
                    jumpToMessage(target);
                  },
                  <ChevronDown key="i" className="h-4 w-4" />,
                ],
                ["最新のメッセージへ", () => jumpToLatest(), <ChevronsDown key="i" className="h-4 w-4" />],
              ] as const
            ).map(([label, onClick, icon]) => (
              <Button
                key={label}
                variant="secondary"
                size="icon"
                aria-label={label}
                title={label}
                className={cx(
                  "h-10 w-10 rounded-full border border-border-strong bg-surface shadow-lg transition-opacity hover:opacity-100 focus-visible:opacity-100 active:opacity-100",
                )}
                style={{ opacity: scrollButtonOpacity }}
                onClick={onClick}
              >
                {icon}
              </Button>
            ))}
          </div>
        )}
        {graphOpen && task?.directory && (
          <SidePanel storageKey="webui.graphpanel.width">
            <GraphPanel directory={task.directory} working={working} />
          </SidePanel>
        )}
        {diffOpen && task?.directory && (
          <SidePanel storageKey="webui.diffpane.width">
            <DiffPane
              directory={task.directory}
              agent={agent || undefined}
              model={
                task.providerID && task.modelID
                  ? { providerID: task.providerID, modelID: task.modelID }
                  : undefined
              }
              onMutated={() => notifyTasksChanged()}
            />
          </SidePanel>
        )}
      </div>
      <div className={cx(
        "shrink-0 border-t border-border bg-surface px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        mobilePanelOpen && "hidden",
      )}>
        {permissionRequest && (
          <div
            role="alertdialog"
            aria-label="危険なコマンドの確認"
            className="mx-auto mb-2 max-w-5xl rounded-lg border border-warning/30 bg-warning-bg px-3 py-3 text-sm text-warning"
          >
            <p className="whitespace-pre-wrap break-all">{permissionRequest.message}</p>
            {permissionRequest.labels.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                検出: {permissionRequest.labels.join(", ")}
              </p>
            )}
            <pre className="mt-2 max-h-32 overflow-auto rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground">
              {permissionRequest.command}
            </pre>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                busy={permissionBusy}
                disabled={permissionBusy}
                onClick={() => {
                  void (async () => {
                    try {
                      setPermissionBusy(true);
                      setError(null);
                      await sendJson(`/api/tasks/${taskId}/permission`, {
                        requestId: permissionRequest.id,
                        approved: true,
                      });
                      setPermissionRequest(null);
                    } catch (err) {
                      const message = err instanceof Error ? err.message : "許可の送信に失敗しました";
                      setError(message);
                      if (/not found|見つかりません/i.test(message)) {
                        setPermissionRequest(null);
                      }
                    } finally {
                      setPermissionBusy(false);
                    }
                  })();
                }}
              >
                許可
              </Button>
              <Button
                variant="danger"
                size="sm"
                busy={permissionBusy}
                disabled={permissionBusy}
                onClick={() => {
                  void (async () => {
                    try {
                      setPermissionBusy(true);
                      setError(null);
                      await sendJson(`/api/tasks/${taskId}/permission`, {
                        requestId: permissionRequest.id,
                        approved: false,
                      });
                      setPermissionRequest(null);
                    } catch (err) {
                      const message = err instanceof Error ? err.message : "拒否の送信に失敗しました";
                      setError(message);
                      if (/not found|見つかりません/i.test(message)) {
                        setPermissionRequest(null);
                      }
                    } finally {
                      setPermissionBusy(false);
                    }
                  })();
                }}
              >
                拒否
              </Button>
            </div>
          </div>
        )}
        {questionRequest && (
          <div className="mb-2">
            <QuestionCard
              request={questionRequest}
              onReply={async (request, answers) => {
                setError(null);
                try {
                  await sendJson(`/api/tasks/${taskId}/question`, {
                    requestId: request.id,
                    answers,
                  });
                  setQuestionRequest(null);
                } catch (err) {
                  const message = err instanceof Error ? err.message : "回答の送信に失敗しました";
                  if (/not found|見つかりません/i.test(message)) setQuestionRequest(null);
                  throw err;
                }
              }}
              onReject={async (request) => {
                setError(null);
                try {
                  await sendJson(`/api/tasks/${taskId}/question`, {
                    requestId: request.id,
                    reject: true,
                  });
                  setQuestionRequest(null);
                } catch (err) {
                  const message = err instanceof Error ? err.message : "拒否の送信に失敗しました";
                  if (/not found|見つかりません/i.test(message)) setQuestionRequest(null);
                  throw err;
                }
              }}
            />
          </div>
        )}
        {isReverted && (
          <div className="mx-auto mb-2 flex max-w-5xl items-center gap-3 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning">
            <span className="min-w-0 flex-1">
              巻き戻し中（以降のメッセージは非表示）
            </span>
            <Button
              variant="secondary"
              size="sm"
              busy={revertBusy}
              onClick={() => void unrevert()}
            >
              復元
            </Button>
          </div>
        )}
        {revertConfirmOpen && (
          <div
            role="alertdialog"
            aria-label="巻き戻しの確認"
            aria-describedby="session-revert-confirm-description"
            className="mx-auto mb-2 max-w-5xl rounded-lg border border-warning/30 bg-warning-bg px-3 py-3 text-sm text-warning"
          >
            <p id="session-revert-confirm-description">
              直前の入力を下の入力欄に戻し、その返答以降を巻き戻しますか？
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                busy={revertBusy}
                disabled={revertBusy || working}
                onClick={() => void revert()}
              >
                巻き戻す
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={revertBusy}
                onClick={() => {
                  setRevertConfirmOpen(false);
                  revertEntryRef.current = null;
                }}
              >
                キャンセル
              </Button>
            </div>
          </div>
        )}
        {compacting && (
          <div className="mx-auto mb-2 flex max-w-5xl items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            <span className="min-w-0 flex-1">
              コンテキストを圧縮しています… 完了まで数分かかることがあります
            </span>
            <Button variant="secondary" size="sm" onClick={() => void abortCompact()}>
              キャンセル
            </Button>
          </div>
        )}
        {sseReconnecting && !error && (
          <p role="status" className="mx-auto mb-2 max-w-5xl rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            イベント接続を再試行しています…
          </p>
        )}
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-5xl rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <GoalLoopPanel
          loop={task?.goalLoop}
          busy={submitting}
          onAction={(action) => void goalLoopAction(action)}
          onResume={(maxTurns) => void goalLoopAction("resume", maxTurns)}
        />
        {goalLoopEnabled && (
          <div className="mx-auto max-w-5xl">
            <GoalLoopOptions
              acceptance={goalLoopAcceptance}
              maxTurns={goalLoopMaxTurns}
              cooldownSeconds={goalLoopCooldownSeconds}
              forceFullRun={goalLoopForceFullRun}
              disabled={submitting || working}
              onAcceptanceChange={setGoalLoopAcceptance}
              onMaxTurnsChange={setGoalLoopMaxTurns}
              onCooldownSecondsChange={setGoalLoopCooldownSeconds}
              onForceFullRunChange={setGoalLoopForceFullRun}
            />
          </div>
        )}
        <div className="mx-auto max-w-5xl">
          <QueuedFollowUpsNotice
            items={queuedFollowUps}
            onRemove={(id) =>
              setQueuedFollowUps((current) => current.filter((item) => item.id !== id))
            }
          />
        </div>
        {task?.sessionId && (
          <NextAction
            taskId={taskId}
            sessionId={task.sessionId}
            model={modelValue}
            invalidateKey={`${messages.length}:${messages.at(-1)?.id ?? ""}:${working ? "working" : "idle"}`}
            disabled={compacting}
            onApply={(suggestion) => {
              setPrompt(suggestion);
              textareaRef.current?.focus();
            }}
          />
        )}
        <Composer
          form={{
            ariaLabel: "フォローアップ",
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
          textarea={{
            ref: textareaRef,
            value: prompt,
            rows: 1,
            ariaLabel: "フォローアップ",
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
            onBlur: () => {
              // composition 中にフォーカスが外れると compositionEnd が来ない
              // ことがあり、stuck true で Ctrl+Enter 送信が永久に無効化される
              composingRef.current = false;
            },
            onKeyDown: (event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composingRef.current) {
                event.preventDefault();
                void submit();
              }
            },
            placeholder: compacting
              ? "圧縮中です…"
              : working
                ? "実行中です。送信するとフォローアップになります…"
                : "続きを指示…（Ctrl+Enter）",
            className: "w-full resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-faint",
            disabled: compacting,
          }}
          references={{ skills, agents }}
          attachmentControl={{
            inputRef: fileInputRef,
            inputDisabled: compacting || goalLoopEnabled,
            buttonDisabled: compacting || goalLoopEnabled,
            buttonTitle: "画像を添付",
            onFilesSelected: addImageFiles,
            onTrigger: () => fileInputRef.current?.click(),
          }}
          toolbar={
            <>
              <ModelSelect
                value={modelValue}
                options={models}
                disabled={working || compacting}
                onChange={(value) => {
                  void (async () => {
                    try {
                      setError(null);
                      const result = await sendJson<{ task: TaskSummary }>(
                        `/api/tasks/${taskId}/model`,
                        { model: value },
                      );
                      setTask((current) => (current ? { ...current, ...result.task } : current));
                      notifyTasksChanged();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "モデルの切替に失敗しました");
                    }
                  })();
                }}
                className="min-w-0 max-w-[10rem] sm:max-w-[12rem]"
              />
              <ThinkingSelect
                levels={thinkingLevels}
                value={thinkingValue}
                disabled={working || compacting}
                onChange={(value) => {
                  void (async () => {
                    try {
                      setError(null);
                      const result = await sendJson<{ task: TaskSummary }>(
                        `/api/tasks/${taskId}/thinking`,
                        { thinkingLevel: value },
                      );
                      setTask((current) => (current ? { ...current, ...result.task } : current));
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "思考レベルの切替に失敗しました");
                    }
                  })();
                }}
              />
              {agents.length > 0 && (
                <AgentSelect
                  value={agent}
                  agents={agents.map(({ name }) => name)}
                  disabled={working || compacting}
                  onChange={(value) => {
                    setAgent(value);
                    writeStoredAgent(value);
                  }}
                  className="min-w-0 max-w-[8rem] sm:max-w-40"
                />
              )}
              <PermissionSelect
                value={permissionMode}
                disabled={working || compacting}
                onChange={(mode) => {
                  setPermissionMode(mode);
                  writePermissionMode(mode);
                  void (async () => {
                    try {
                      await sendJson(`/api/tasks/${taskId}/permission-mode`, { mode });
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "権限モードの更新に失敗しました");
                    }
                  })();
                }}
                className="h-8 shrink-0"
              />
              <SkillPermissionSelect
                value={skillPermission}
                disabled={working || compacting}
                onChange={(permission) => {
                  void (async () => {
                    try {
                      await sendJson(
                        `/api/tasks/${taskId}/skill-permission`,
                        { permission },
                      );
                      setSkillPermission(permission);
                      writeSkillPermission(permission);
                      setError(null);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "スキル権限の更新に失敗しました");
                    }
                  })();
                }}
                className="h-8 shrink-0"
              />
              <SubagentPermissionSelect
                value={subagentPermission}
                disabled={working || compacting}
                onChange={(mode) => {
                  setSubagentPermission(mode);
                  writeSubagentPermission(mode);
                }}
                className="h-8 shrink-0"
              />
              <GoalLoopToggle
                enabled={goalLoopEnabled}
                disabled={submitting || working || Boolean(task?.goalLoop && !["completed", "blocked", "stopped"].includes(task.goalLoop.status))}
                onToggle={() => setGoalLoopEnabled((value) => !value)}
              />
              <GhostSelect
                value={deliveryMode}
                disabled={!task || compacting}
                aria-label="送信方式"
                title={deliveryMode === "queue" ? "現在の処理後に送信" : "実行中の処理へ割り込み"}
                icon={
                  deliveryMode === "queue" ? (
                    <ListPlus className="h-3.5 w-3.5" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )
                }
                valueLabel={deliveryMode === "queue" ? "キュー" : "割り込み"}
                className="max-w-[8rem] shrink-0"
                onChange={(value) => {
                  if (value === "queue" || value === "steer") setDeliveryMode(value);
                }}
              >
                <option value="queue" title="現在の処理後に送信">
                  キュー
                </option>
                <option value="steer" title="実行中の処理へ割り込み">
                  割り込み
                </option>
              </GhostSelect>
            </>
          }
          action={
            working && !prompt.trim() && attachments.length === 0 ? (
              <Button
                variant="danger"
                size="icon"
                aria-label="停止"
                title="停止"
                onClick={() => void abortWorking()}
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="icon"
                type="submit"
                aria-label="送信"
                busy={submitting}
                disabled={compacting || (!prompt.trim() && attachments.length === 0)}
              >
                {!submitting && <ArrowUp className="h-4.5 w-4.5" />}
              </Button>
            )
          }
        />
      </div>
    </div>
  );
}

"use client";

import { memo, startTransition, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  GitGraph,
  ListPlus,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  WandSparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import {
  COMPOSER_ACTION_BUTTON_CLASS,
  Composer,
  type ComposerAttachment,
  type ComposerReference,
} from "@/components/Composer";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { isImeComposingEvent } from "@/lib/composer-ime";
import { GoalLoopPanel } from "@/components/GoalLoopPanel";
import { DiffPane } from "@/components/task/DiffPane";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { NextAction } from "@/components/task/NextAction";
import { GraphPanel } from "@/components/task/GraphPanel";
import { ProjectExplorerButton } from "@/components/task/ProjectExplorerButton";
import { TodoProgressPanel } from "@/components/task/TodoProgressPanel";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { AgentSelect } from "@/components/AgentSelect";
import { SubagentPermissionSelect } from "@/components/SubagentPermissionSelect";
import { SkillPermissionSelect } from "@/components/SkillPermissionSelect";
import { PermissionSelect } from "@/components/PermissionSelect";
import { StatusBadge } from "@/components/StatusBadge";
import { MobileMenuButton } from "@/components/shell/MobileMenuHeader";
import { MessageMetaHeader, PartView, ToolCard, WorkingRow } from "@/components/task/PartView";
import { PermissionAdvice } from "@/components/task/PermissionAdvice";
import { QuestionCard } from "@/components/task/QuestionCard";
import {
  QueuedFollowUpsNotice,
  type QueuedFollowUp,
} from "@/components/task/QueuedFollowUpsNotice";
import { Badge, Button, cx, GhostSelect } from "@/components/ui";
import {
  AUTO_MODEL_OPTION,
  AUTO_MODEL_VALUE,
  autoModelValue,
  autoVariantToThinkingLevel,
  type AutoDecision,
  type AutoOptimizeMode,
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
import {
  AUTO_TASK_PROMPT_MAX,
  clearAutoTaskRecord,
  readAutoTaskRecord,
  resolveModelValue,
  shouldAutoRetryEscalate,
  writeAutoTaskRecord,
  type AutoTaskRecord,
} from "@/lib/auto-task-record";
import { formatTokens, type ContextUsageDto } from "@/lib/context-usage";
import { TITLE_MAX_CHARS } from "@/lib/direct-generation-text";
import {
  DEFAULT_TITLE_AUTO_UPDATE_ENABLED,
  DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY,
  hasStoredTitleAutoUpdateEnabled,
  hasStoredTitleAutoUpdateFrequency,
  parseTitleAutoUpdateEnabled,
  parseTitleAutoUpdateFrequency,
  readTitleAutoUpdateEnabled,
  readTitleAutoUpdateEnabledFromServer,
  readTitleAutoUpdateFrequency,
  readTitleAutoUpdateFrequencyFromServer,
  resolveTitleAutoUpdateEnabled,
  shouldAutoUpdateTitle,
  subscribeTitleAutoUpdateEnabled,
  subscribeTitleAutoUpdateFrequency,
  writeTitleAutoUpdateEnabled,
  writeTitleAutoUpdateFrequency,
} from "@/lib/title-auto-update-settings";
import { formatTokensPerSecond } from "@/lib/token-throughput";
import { notifyTasksChanged } from "@/lib/events";
import { taskSidebarNotifyKey } from "@/lib/task-sidebar-notify";
import { getJson, sendJson } from "@/lib/client";
import { readCachedModels, writeCachedModels } from "@/lib/models-cache";
import {
  AUTO_AGENT_VALUE,
  DEFAULT_AGENT,
  readStoredAgent,
  resolveAgentSelection,
  writeStoredAgent,
} from "@/lib/default-agent";
import { messageNavigationTarget } from "@/lib/message-navigation";
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
  shouldKeepCachedBootstrapMessages,
  type TaskSessionCacheSnapshot,
} from "@/lib/task-session-cache";
import {
  findResumableTurn,
  shouldAttachResumeImages,
  shouldAutoResumeSilentTurn,
  shouldClearStopRequestedOnWorkingTransition,
  type ResumableTurn,
} from "@/lib/aborted-resume";
import {
  shouldAutoSendQueuedFollowUp,
  shouldClearPendingUserMessageOnEvent,
  shouldClearQueuedFollowUpOnAbortState,
  shouldClearQueuedFollowUpOnEvent,
  shouldDrainQueuedFollowUp,
  shouldQueueFollowUp,
  shouldSendSteerBehavior,
  shouldShowOptimisticPendingUser,
} from "@/lib/queued-follow-up";
import { isHangRetryUserMessage } from "@/lib/hang-retry";
import { mergeTaskDelta, type TaskDeltaState } from "@/lib/task-delta";
import {
  cancelPendingSseReconnect,
  closeSseSource,
  sseReconnectDelayMs,
} from "@/lib/sse-reconnect";

const MODEL_KEY = "leafcodepi.defaultModel";

function writeStoredModel(model: string): void {
  try {
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    /* private mode 等では永続できないだけ */
  }
}
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
import {
  isThinkingLevel,
  resolveThinkingLevel,
  thinkingLevelMetaLabel,
  writeStoredThinkingLevel,
} from "@/lib/thinking-levels";
import {
  readSubagentPermission,
  writeSubagentPermission,
  type SubagentPermission,
} from "@/lib/subagent-permission";
import {
  readSkillPermission,
  type SkillPermission,
} from "@/lib/skill-permission";
import {
  readPermissionMode,
  type PermissionMode,
} from "@/lib/permission-gate";
import type {
  DiffFilesPayload,
  GoalLoopDto,
  GoalLoopTurn,
  ModelOption,
  PermissionRequestDto,
  QuestionRequestDto,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TodoDto,
  ThinkingLevel,
  UiMessage,
  UiPart,
} from "@/lib/types";
import { statusFromChangedFileCount, type WorktreeStatus } from "@/lib/worktree-status";

const TASK_SESSION_CACHE_THROTTLE_MS = 1_000;
const TASK_PERF_ENABLED = process.env.NODE_ENV === "development";
let nextTaskPerfId = 0;

type TaskPerformanceState = {
  id: number;
  connectedAt: number | null;
  bootstrapAt: number | null;
  readyAt: number | null;
  firstPaintAt: number | null;
  firstDeltaAt: number | null;
  snapshotCount: number;
  snapshotChars: number;
  deltaCount: number;
  deltaChars: number;
  reported: boolean;
};

function taskPerfNow(): number | null {
  return TASK_PERF_ENABLED && typeof performance !== "undefined"
    ? performance.now()
    : null;
}

function taskPerfMark(id: number, phase: string): void {
  if (!TASK_PERF_ENABLED || typeof performance === "undefined") return;
  performance.mark(`leafcodepi:task:${id}:${phase}`);
}

function reportTaskPerformance(perf: TaskPerformanceState): void {
  if (
    !TASK_PERF_ENABLED ||
    perf.reported ||
    perf.readyAt === null ||
    perf.firstPaintAt === null
  ) {
    return;
  }
  perf.reported = true;
  const prefix = `leafcodepi:task:${perf.id}`;
  try {
    performance.measure(`${prefix}:bootstrap-ttfb`, `${prefix}:connect`, `${prefix}:bootstrap`);
    performance.measure(`${prefix}:ready`, `${prefix}:connect`, `${prefix}:ready`);
    performance.measure(`${prefix}:ready-to-paint`, `${prefix}:ready`, `${prefix}:first-paint`);
  } catch {
    /* Performance marks are diagnostic only. */
  }
  console.debug("[leafcodepi:task-perf]", {
    instance: perf.id,
    bootstrapTtfbMs:
      perf.connectedAt !== null && perf.bootstrapAt !== null
        ? Math.round(perf.bootstrapAt - perf.connectedAt)
        : null,
    readyMs:
      perf.connectedAt !== null && perf.readyAt !== null
        ? Math.round(perf.readyAt - perf.connectedAt)
        : null,
    readyToPaintMs:
      perf.readyAt !== null ? Math.round(perf.firstPaintAt - perf.readyAt) : null,
    firstDeltaMs:
      perf.connectedAt !== null && perf.firstDeltaAt !== null
        ? Math.round(perf.firstDeltaAt - perf.connectedAt)
        : null,
    snapshotCount: perf.snapshotCount,
    snapshotChars: perf.snapshotChars,
    deltaCount: perf.deltaCount,
    deltaChars: perf.deltaChars,
  });
}

function hasCompletedTitleTurn(messages: UiMessage[]): boolean {
  let hasAssistant = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === "assistant") hasAssistant = true;
    if (role === "user") return hasAssistant;
  }
  return false;
}

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
    a.titleAutoUpdate === b.titleAutoUpdate &&
    a.providerID === b.providerID &&
    a.modelID === b.modelID &&
    a.accountId === b.accountId &&
    a.thinkingLevel === b.thinkingLevel &&
    a.error === b.error &&
    a.agent === b.agent &&
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.updatedAt === b.updatedAt &&
    a.revertLeafId === b.revertLeafId &&
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
const SIDE_PANEL_DEFAULT_WIDTH = 320;
const SIDE_PANEL_MAX_WIDTH = 640;
/** Both panels must leave a readable minimum width for the timeline. */
const TIMELINE_MIN_WIDTH = 480;

function readSidePanelWidth(storageKey: string): number {
  if (typeof window === "undefined") return SIDE_PANEL_DEFAULT_WIDTH;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= SIDE_PANEL_MIN_WIDTH
      ? Math.min(saved, SIDE_PANEL_MAX_WIDTH)
      : SIDE_PANEL_DEFAULT_WIDTH;
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

/** 右側パネル（Graph / Diff）の幅を左端ドラッグで調整できるラッパー。 */
function SidePanel({
  storageKey,
  children,
  onWidthChange,
}: {
  storageKey: string;
  children: React.ReactNode;
  onWidthChange?: (width: number) => void;
}) {
  const [width, setWidth] = useState(() => readSidePanelWidth(storageKey));
  useEffect(() => {
    setWidth(readSidePanelWidth(storageKey));
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
          let nextWidth = width;
          const onMove = (move: PointerEvent) => {
            nextWidth = Math.min(
              SIDE_PANEL_MAX_WIDTH,
              Math.max(SIDE_PANEL_MIN_WIDTH, startWidth - (move.clientX - startX)),
            );
            setWidth(nextWidth);
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            localStorage.setItem(storageKey, String(nextWidth));
            onWidthChange?.(nextWidth);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
    </div>
  );
}

function sameGoalLoopTurn(a: GoalLoopTurn, b: GoalLoopTurn): boolean {
  return a.goalId === b.goalId && a.turn === b.turn && a.kind === b.kind;
}

/** Show one divider per Goal Loop turn, even when compaction rows intervene. */
function isGoalLoopTurnBoundary(messages: UiMessage[], index: number): boolean {
  const turn = messages[index]?.goalLoopTurn;
  if (!turn) return false;
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previous = messages[previousIndex]!;
    if (previous.role === "user" && !previous.goalLoopTurn) return true;
    if (previous.goalLoopTurn) return !sameGoalLoopTurn(previous.goalLoopTurn, turn);
  }
  return true;
}

function GoalLoopTurnDivider({ turn }: { turn: GoalLoopTurn }) {
  const title = `Goalターン ${turn.turn}`;
  const verification = turn.kind === "verification";
  return (
    <div
      role="separator"
      aria-label={`${title}${verification ? "（完了検証）" : ""}`}
      className="flex items-center gap-3 py-1 text-xs text-faint"
    >
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 font-medium tabular-nums">
        <span>{title}</span>
        {verification && <span className="text-muted">検証</span>}
      </span>
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
    </div>
  );
}

type TaskToolPart = Extract<UiPart, { type: "tool" }>;

type TaskActivityEntry = {
  message: UiMessage;
  activityMessage: UiMessage;
  showHeader: boolean;
};

type TaskMessageBlock =
  | { kind: "message"; message: UiMessage; index: number }
  | {
      kind: "tool-group";
      entries: TaskActivityEntry[];
      startIndex: number;
      showTurnDivider: boolean;
    };

/** assistant の本文だけをメッセージとして残し、それ以外の表示要素を活動グループへ送る。 */
function taskActivityEntry(message: UiMessage): TaskActivityEntry | null {
  if (message.role !== "assistant") return null;
  const activityParts = message.parts.filter((part) => part.type !== "text");
  const hasActivity =
    activityParts.length > 0 || Boolean(message.error) || (message.diagnostics?.length ?? 0) > 0;
  if (!hasActivity) return null;
  return {
    message,
    activityMessage:
      activityParts.length === message.parts.length
        ? message
        : { ...message, parts: activityParts },
    showHeader: !message.parts.some((part) => part.type === "text"),
  };
}

function taskTextMessage(message: UiMessage): UiMessage {
  return {
    ...message,
    parts: message.parts.filter((part) => part.type === "text"),
    error: undefined,
    diagnostics: undefined,
  };
}

function taskActivityCount(entry: TaskActivityEntry): number {
  return (
    entry.activityMessage.parts.length +
    (entry.activityMessage.error ? 1 : 0) +
    (entry.activityMessage.diagnostics?.length ?? 0)
  );
}

function taskMessageBlocks(messages: UiMessage[], ungroupedMessageId?: string): TaskMessageBlock[] {
  const blocks: TaskMessageBlock[] = [];
  let groupedEntries: TaskActivityEntry[] = [];
  let groupStartIndex = -1;
  let groupShowTurnDivider = false;
  const flushGroup = () => {
    if (groupedEntries.length === 0 || groupStartIndex < 0) return;
    blocks.push({
      kind: "tool-group",
      entries: groupedEntries,
      startIndex: groupStartIndex,
      showTurnDivider: groupShowTurnDivider,
    });
    groupedEntries = [];
    groupStartIndex = -1;
    groupShowTurnDivider = false;
  };
  const addActivity = (entry: TaskActivityEntry, index: number, showTurnDivider: boolean) => {
    if (groupStartIndex < 0) {
      groupStartIndex = index;
      groupShowTurnDivider = showTurnDivider;
    } else if (isGoalLoopTurnBoundary(messages, index)) {
      flushGroup();
      groupStartIndex = index;
      groupShowTurnDivider = true;
    }
    groupedEntries.push(entry);
  };

  messages.forEach((message, index) => {
    const activity = message.id === ungroupedMessageId ? null : taskActivityEntry(message);
    const hasText =
      message.role === "assistant" && message.parts.some((part) => part.type === "text");
    if (hasText) {
      flushGroup();
      blocks.push({ kind: "message", message: activity ? taskTextMessage(message) : message, index });
      if (activity) addActivity(activity, index, false);
      return;
    }
    if (activity) {
      addActivity(activity, index, isGoalLoopTurnBoundary(messages, index));
      return;
    }
    flushGroup();
    blocks.push({ kind: "message", message, index });
  });
  flushGroup();
  return blocks;
}

function TaskToolActivityGroup({
  messageHeaders,
  contents,
  count,
}: {
  messageHeaders: ReactNode[];
  contents: ReactNode[];
  count: number;
}) {
  return (
    <div className="w-full min-w-0">
      <div className="mb-1 flex min-w-0 flex-col gap-1">{messageHeaders}</div>
      <details
        data-task-tool-group
        aria-label="ツール実行"
        className="group/task-tool-activity w-full max-w-bubble self-start overflow-hidden rounded-2xl border border-border bg-surface"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-surface-2 px-3 py-2.5 text-left text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="h-4 w-4 shrink-0 transition-transform group-open/task-tool-activity:rotate-90"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 font-medium">ツール実行</span>
          <span className="shrink-0 text-xs text-faint">{count}件</span>
        </summary>
        <div className="space-y-2 border-t border-border bg-surface p-2">{contents}</div>
      </details>
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
      <span className="h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-surface-2 @min-[48rem]/task:w-10">
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
      <span className="font-mono tabular-nums">
        {usedLabel}/{limitLabel} ({pctLabel})
      </span>
    </span>
  );
}

export const TaskView = memo(function TaskView({
  taskId,
  mdUp,
  active = true,
  onStatus,
  onAddPane,
}: {
  taskId: string;
  /** ペインコンテキスト全体を購読せず、ブレークポイントだけ受け取る。 */
  mdUp: boolean;
  /** 非アクティブタブは hidden mount（CSS で非表示、SSE は維持）。 */
  active?: boolean;
  /** SSE snapshot の status 変化をタブバッジへ報告する（TaskPanesProvider）。 */
  onStatus?: (taskId: string, status: TaskStatus) => void;
  /** 1 ペイン時にも分割を開始できるよう空ペインを追加する。 */
  onAddPane?: () => void;
}) {
  const [cachedSession] = useState(() => loadTaskSessionCache(taskId));
  const [task, setTask] = useState<TaskDetail | null>(cachedSession);
  const { botFor } = useTaskPanes();
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>(() => cachedSession?.messages ?? []);
  const [pendingUserMessage, setPendingUserMessage] = useState<{
    message: UiMessage;
    baselineUserCount: number;
  } | null>(null);
  const [models, setModels] = useState<ModelOption[]>(() => readCachedModels() ?? []);
  // キャッシュ hit なら loading を立てず、裏で /api/models を再検証する。
  const [modelsLoading, setModelsLoading] = useState(() => models.length === 0);
  const [modelSelection, setModelSelection] = useState("");
  const modelChangeRef = useRef(0);
  const [autoOptimizeMode, setAutoOptimizeMode] = useState<AutoOptimizeMode>(
    () => readAutoOptimizeMode(),
  );
  const [autoRouteConfig, setAutoRouteConfig] = useState(() => readAutoRouteConfig());
  const [autoRecord, setAutoRecord] = useState<AutoTaskRecord | null>(null);
  const [autoRetryNotice, setAutoRetryNotice] = useState<string | null>(null);
  const [autoRetrying, setAutoRetrying] = useState(false);
  const autoRetryStatusRef = useRef<TaskStatus | undefined>(cachedSession?.status);
  const [contextUsage, setContextUsage] = useState<ContextUsageDto | undefined>(
    () => cachedSession?.contextUsage,
  );
  const [isCompacting, setIsCompacting] = useState(Boolean(cachedSession?.isCompacting));
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const revertEntryRef = useRef<{ messageId: string; message: UiMessage | undefined } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleUpdateFrequency, setTitleUpdateFrequency] = useState(
    DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY,
  );
  const [titleAutoUpdateDefault, setTitleAutoUpdateDefault] = useState(
    DEFAULT_TITLE_AUTO_UPDATE_ENABLED,
  );
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
  const [panelWidths, setPanelWidths] = useState(() => ({
    graph: readSidePanelWidth("webui.graphpanel.width"),
    diff: readSidePanelWidth("webui.diffpane.width"),
  }));
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<"queue" | "steer">("queue");
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const [queuedAutoSend, setQueuedAutoSend] = useState(false);
  const nextQueueIdRef = useRef(1);
  const nextOptimisticMessageIdRef = useRef(1);
  const queuedSendRef = useRef<QueuedFollowUp | null>(null);
  const submitRef = useRef<(queued?: QueuedFollowUp) => Promise<void>>(async () => undefined);
  const [submitting, setSubmitting] = useState(false);
  const [resumingTurn, setResumingTurn] = useState(false);
  const [resumeTurnError, setResumeTurnError] = useState<string | null>(null);
  const [manualAbortedAssistantId, setManualAbortedAssistantId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  const prevStatusWorkingRef = useRef(false);
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
  // agent is the persisted session persona; agentSelection is the user's
  // displayed/input choice and may remain Auto after the server resolves it.
  const [agent, setAgent] = useState(
    () => cachedSession?.agent?.trim() || DEFAULT_AGENT,
  );
  const [agentSelection, setAgentSelection] = useState(
    // Composer 既定の Auto は既存タスクへ持ち込まない。明示選択時だけ Auto を維持する。
    () => {
      const stored = readStoredAgent();
      if (stored === AUTO_AGENT_VALUE) {
        return cachedSession?.agent?.trim() || DEFAULT_AGENT;
      }
      return stored || cachedSession?.agent?.trim() || DEFAULT_AGENT;
    },
  );
  const [agentChanging, setAgentChanging] = useState(false);
  const [accountLabels, setAccountLabels] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    getJson<{ accounts: { id: string; label: string }[] }>("/api/accounts")
      .then((res) => {
        if (!cancelled) {
          setAccountLabels(new Map(res.accounts.map((account) => [account.id, account.label])));
        }
      })
      .catch(() => {
        // 取得失敗時は ID をそのまま表示する（TaskAccountBadge と同じ契約）。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const taskAccountLabel = task?.accountId
    ? accountLabels.get(task.accountId) ?? task.accountId
    : null;
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
  useEffect(() => {
    const unsubscribeMode = subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, () =>
      setAutoOptimizeMode(readAutoOptimizeMode()),
    );
    const unsubscribeRouteConfig = subscribeAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY, () =>
      setAutoRouteConfig(readAutoRouteConfig()),
    );
    return () => {
      unsubscribeMode();
      unsubscribeRouteConfig();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void readAutoSettingsFromServer().then((snapshot) => {
      if (!active) return;
      if (snapshot.mode && !hasStoredAutoSetting(AUTO_OPTIMIZE_SETTING_KEY)) {
        writeAutoOptimizeMode(snapshot.mode);
        setAutoOptimizeMode(snapshot.mode);
      }
      if (
        snapshot.routeConfig &&
        !hasStoredAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY)
      ) {
        writeAutoRouteConfig(snapshot.routeConfig);
        setAutoRouteConfig(snapshot.routeConfig);
      }
    });
    void readTitleAutoUpdateFrequencyFromServer().then((serverValue) => {
      if (
        !active ||
        serverValue === null ||
        hasStoredTitleAutoUpdateFrequency()
      ) return;
      const next = parseTitleAutoUpdateFrequency(serverValue);
      writeTitleAutoUpdateFrequency(next);
      setTitleUpdateFrequency(next);
    });
    void readTitleAutoUpdateEnabledFromServer().then((serverValue) => {
      if (
        !active ||
        serverValue === null ||
        hasStoredTitleAutoUpdateEnabled()
      ) return;
      const next = parseTitleAutoUpdateEnabled(serverValue);
      writeTitleAutoUpdateEnabled(next);
      setTitleAutoUpdateDefault(next);
    });
    return () => {
      active = false;
    };
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const taskViewRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [taskViewWidth, setTaskViewWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = taskViewRef.current;
    if (!element) return;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0) return;
      setTaskViewWidth((current) => (current === width ? current : width));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const panelsCanBeSimultaneous =
    mdUp &&
    (taskViewWidth === null ||
      taskViewWidth >= TIMELINE_MIN_WIDTH + panelWidths.graph + panelWidths.diff);
  useLayoutEffect(() => {
    setPanelState((current) =>
      normalizeTaskPanelState(current, panelsCanBeSimultaneous),
    );
  }, [panelsCanBeSimultaneous]);

  const onGraphPanelWidthChange = useCallback((width: number) => {
    setPanelWidths((current) =>
      current.graph === width ? current : { ...current, graph: width },
    );
  }, []);
  const onDiffPanelWidthChange = useCallback((width: number) => {
    setPanelWidths((current) =>
      current.diff === width ? current : { ...current, diff: width },
    );
  }, []);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const previousWorkingRef = useRef(false);
  const titleTaskRef = useRef(taskId);
  const titleCompletionPendingRef = useRef(false);
  const titleUpdatedTurnRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleMutationRef = useRef(0);
  // メッセージ間をジャンプするナビゲーター（本家 LeafCode と同じ）。
  // 描画済みメッセージ要素と「今どのナビゲーション対象を見ているか」を保持する。
  const messageElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // onScroll の deps を安定させるため、id 一覧を ref にミラーする（本家と同じ）。
  const navigationMessageIdsRef = useRef<string[]>([]);
  // 呼び出し元（TaskPanesHost）は毎レンダーで新しい onStatus 関数を渡すため、
  // そのまま SSE effect の deps に入れると親の再描画ごとに EventSource が
  // 張り直される。latest-ref 経由で呼び、effect を taskId 変化時のみ再接続に限定する。
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);
  useEffect(() => {
    if (!titleEditing) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [titleEditing]);
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
  useEffect(() => {
    setTitleUpdateFrequency(readTitleAutoUpdateFrequency());
    setTitleAutoUpdateDefault(readTitleAutoUpdateEnabled());
    const unsubscribeFrequency = subscribeTitleAutoUpdateFrequency(() =>
      setTitleUpdateFrequency(readTitleAutoUpdateFrequency()),
    );
    const unsubscribeEnabled = subscribeTitleAutoUpdateEnabled(() =>
      setTitleAutoUpdateDefault(readTitleAutoUpdateEnabled()),
    );
    return () => {
      unsubscribeFrequency();
      unsubscribeEnabled();
    };
  }, []);
  const sidebarNotifyKeyRef = useRef("");
  const cacheSnapshotRef = useRef<TaskSessionCacheSnapshot | null>(null);
  const cacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskPerfRef = useRef<TaskPerformanceState | null>(null);
  if (taskPerfRef.current === null) {
    taskPerfRef.current = {
      id: ++nextTaskPerfId,
      connectedAt: null,
      bootstrapAt: null,
      readyAt: null,
      firstPaintAt: null,
      firstDeltaAt: null,
      snapshotCount: 0,
      snapshotChars: 0,
      deltaCount: 0,
      deltaChars: 0,
      reported: false,
    };
  }
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
    // before the host is quit, without serializing the full cache every few
    // hundred milliseconds.
    if (cacheTimerRef.current !== null) return;
    cacheTimerRef.current = setTimeout(() => {
      cacheTimerRef.current = null;
      const latest = cacheSnapshotRef.current;
      if (latest) saveTaskSessionCache(latest);
    }, TASK_SESSION_CACHE_THROTTLE_MS);
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
    if ("manualAbortedAssistantId" in detail) {
      setManualAbortedAssistantId(detail.manualAbortedAssistantId ?? null);
    }
    if (typeof detail.hangRetryCount === "number") {
      setHangRetryCount(detail.hangRetryCount);
    }
    setSkillPermission(detail.skillPermission ?? readSkillPermission());
    setPermissionMode(detail.permissionMode ?? readPermissionMode());
    // セッション人格は作成時固定。Auto 選択中は送信待ちの選択を維持する。
    const nextAgent = detail.agent?.trim() || DEFAULT_AGENT;
    setAgent(nextAgent);
    setAgentSelection((current) =>
      current === AUTO_AGENT_VALUE ? current : nextAgent,
    );
  }, []);

  const notifySidebarIfNeeded = useCallback((snapshotTask?: TaskSummary | TaskDetail | null) => {
    if (!snapshotTask) return;
    const key = taskSidebarNotifyKey(snapshotTask);
    if (key === sidebarNotifyKeyRef.current) return;
    sidebarNotifyKeyRef.current = key;
    notifyTasksChanged();
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const perf = taskPerfRef.current;
    if (TASK_PERF_ENABLED && perf) {
      perf.connectedAt = taskPerfNow();
      perf.bootstrapAt = null;
      perf.readyAt = null;
      perf.firstPaintAt = null;
      perf.firstDeltaAt = null;
      perf.snapshotCount = 0;
      perf.snapshotChars = 0;
      perf.deltaCount = 0;
      perf.deltaChars = 0;
      perf.reported = false;
      if (perf.connectedAt !== null) taskPerfMark(perf.id, "connect");
    }
    sidebarNotifyKeyRef.current = "";
    setManualAbortedAssistantId(null);
    setHangRetryCount(0);
    setResumeTurnError(null);
    setPermissionRequest(null);
    setPermissionBusy(false);
    // Do not evaluate cached messages as authoritative until the SSE ready
    // snapshot replaces them with the server session state.
    setSessionHydrating(true);
    setSseReconnecting(false);
    // キャッシュ済みモデルがあれば loading を立てず、裏で再検証する。
    if ((readCachedModels()?.length ?? 0) === 0) setModelsLoading(true);

    const connect = () => {
      if (closed) return;
      retryTimer = cancelPendingSseReconnect(retryTimer);
      source = closeSseSource(source);
      // 一部の端末・中継が no-cache の SSE URL を再利用し、reload 後に
      // 古いストリームを返すことがあるため、接続ごとに URL を変える。
      // 安定したアイドル履歴は、キャッシュの revision が一致すれば ready
      // で再送しない。working/compacting のキャッシュは提示しない。
      const eventParams = new URLSearchParams({ epoch: String(Date.now()) });
      if (
        cachedSession &&
        cachedSession.sessionId &&
        cachedSession.updatedAt &&
        cachedSession.status !== "working" &&
        !cachedSession.isStreaming &&
        !cachedSession.isCompacting
      ) {
        eventParams.set("cachedTaskUpdatedAt", cachedSession.updatedAt);
        eventParams.set("cachedSessionId", cachedSession.sessionId);
      }
      source = new EventSource(`/api/tasks/${taskId}/events?${eventParams.toString()}`);
      source.addEventListener("snapshot", (event) => {
        if (closed) return;
        const rawData = (event as MessageEvent).data as string;
        if (TASK_PERF_ENABLED && perf) {
          perf.snapshotCount += 1;
          perf.snapshotChars += typeof rawData === "string" ? rawData.length : 0;
        }
        if (retryCount > 0) setError(null);
        setSseReconnecting(false);
        retryCount = 0;
        let payload: {
          task?: TaskSummary;
          messages?: UiMessage[];
          isStreaming?: boolean;
          isCompacting?: boolean;
          contextUsage?: ContextUsageDto;
          goalLoop?: GoalLoopDto | null;
          todos?: TodoDto[];
          error?: string;
          manualAbortedAssistantId?: string | null;
          hangRetryCount?: number;
          revertLeafId?: string | null;
          permissionRequest?: PermissionRequestDto | null;
          questionRequest?: QuestionRequestDto | null;
          eventType?: string;
          messagesReused?: boolean;
        };
        try {
          payload = JSON.parse(rawData) as typeof payload;
        } catch {
          setError("イベントデータの解析に失敗しました");
          return;
        }
        const snapshotTask = payload.task;
        const isBootstrap = payload.eventType === "bootstrap";
        if (TASK_PERF_ENABLED && perf) {
          const at = taskPerfNow();
          if (at !== null && isBootstrap && perf.bootstrapAt === null) {
            perf.bootstrapAt = at;
            taskPerfMark(perf.id, "bootstrap");
          } else if (at !== null && !isBootstrap && perf.readyAt === null) {
            perf.readyAt = at;
            taskPerfMark(perf.id, "ready");
          }
        }
        // Bootstrap marks a new hydration epoch. Set this urgently so a
        // reconnect cannot clear its gate and auto-resume cached state first.
        if (isBootstrap) setSessionHydrating(true);
        startTransition(() => {
          if (!isBootstrap) setSessionHydrating(false);
          if (snapshotTask) {
            const nextAgent = snapshotTask.agent?.trim() || DEFAULT_AGENT;
            setAgent(nextAgent);
            setAgentSelection((current) =>
              current === AUTO_AGENT_VALUE ? current : nextAgent,
            );
            setTask((current) => {
              const base: TaskDetail = current ?? {
                ...snapshotTask,
                messages: [],
                isStreaming: payload.isStreaming ?? snapshotTask.status === "working",
                isCompacting: Boolean(payload.isCompacting),
              };
              const keepExistingMessages = shouldKeepCachedBootstrapMessages({
                currentTaskId: base.id,
                snapshotTaskId: snapshotTask.id,
                isBootstrap,
                snapshotMessages: payload.messages,
                currentMessageCount: base.messages.length,
              });
              const next: TaskDetail = {
                ...base,
                ...snapshotTask,
                messages: keepExistingMessages
                  ? base.messages
                  : payload.messages ?? base.messages ?? [],
                isStreaming: payload.isStreaming ?? base.isStreaming,
                isCompacting: payload.isCompacting ?? base.isCompacting,
                contextUsage: payload.contextUsage ?? base.contextUsage,
                goalLoop: "goalLoop" in payload ? payload.goalLoop : base.goalLoop,
                todos: payload.todos ?? base.todos,
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
          if (
            shouldClearQueuedFollowUpOnEvent(payload.eventType) ||
            ("manualAbortedAssistantId" in payload &&
              shouldClearQueuedFollowUpOnAbortState(payload.manualAbortedAssistantId))
          ) {
            setQueuedFollowUps([]);
            queuedSendRef.current = null;
            setQueuedAutoSend(false);
          }
          if (shouldClearPendingUserMessageOnEvent(payload.eventType)) {
            setPendingUserMessage(null);
          }
          if (typeof payload.hangRetryCount === "number") {
            setHangRetryCount(payload.hangRetryCount);
          }
          if ("revertLeafId" in payload) {
            setTask((current) => {
              if (!current) return current;
              const nextId = payload.revertLeafId ?? null;
              if ((current.revertLeafId ?? null) === nextId) return current;
              return { ...current, revertLeafId: nextId };
            });
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
        if (status) onStatusRef.current?.(taskId, status);
      });
      source.addEventListener("delta", (event) => {
        if (closed) return;
        const rawData = (event as MessageEvent).data as string;
        if (TASK_PERF_ENABLED && perf) {
          perf.deltaCount += 1;
          perf.deltaChars += typeof rawData === "string" ? rawData.length : 0;
          if (perf.firstDeltaAt === null) {
            const at = taskPerfNow();
            if (at !== null) {
              perf.firstDeltaAt = at;
              taskPerfMark(perf.id, "first-delta");
            }
          }
        }
        let payload: {
          message?: UiMessage | null;
        } & TaskDeltaState;
        try {
          payload = JSON.parse(rawData) as typeof payload;
        } catch {
          setError("イベントデータの解析に失敗しました");
          return;
        }
        startTransition(() => {
          if (payload.task) {
            const nextAgent = payload.task.agent?.trim() || DEFAULT_AGENT;
            setAgent(nextAgent);
            setAgentSelection((current) =>
              current === AUTO_AGENT_VALUE ? current : nextAgent,
            );
          }
          if (
            payload.task ||
            "isStreaming" in payload ||
            "isCompacting" in payload ||
            "contextUsage" in payload
          ) {
            setTask((current) => {
              const next = mergeTaskDelta(current, payload);
              if (!current || !next) return next;
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
        if (payload.task?.status) onStatusRef.current?.(taskId, payload.task.status);
      });
      source.addEventListener("error", (event) => {
        if (closed) return;
        if (event instanceof MessageEvent && typeof event.data === "string") {
          closed = true;
          setSseReconnecting(false);
          source = closeSseSource(source);
          retryTimer = cancelPendingSseReconnect(retryTimer);
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
        source = closeSseSource(source);
        retryTimer = cancelPendingSseReconnect(retryTimer);
        retryCount += 1;
        const delay = sseReconnectDelayMs(retryCount);
        retryTimer = setTimeout(connect, delay);
      });
    };

    // The SSE endpoint sends the initial full snapshot; avoid a duplicate task-detail request.
    connect();

    void getJson<{ models: ModelOption[] }>("/api/models").then((result) => {
      if (!closed) {
        setModels(result.models);
        writeCachedModels(result.models);
        setModelsLoading(false);
      }
    }).catch(() => {
      if (!closed) {
        setModelsLoading(false);
      }
      /* models are optional for the timeline */
    });
    void getJson<{ agents: { name: string; description?: string; enabled: boolean; model?: string; tools?: string[] }[] }>("/api/agents").then((result) => {
      if (!closed) {
        const enabledAgents = result.agents
          .filter((a) => a.enabled)
          .map(({ name, description, tools }) => ({ name, description, tools }));
        const enabledAgentNames = enabledAgents.map(({ name }) => name);
        setAgents(enabledAgents);
        setAgent((current) => resolveAgentSelection(current, enabledAgentNames));
        setAgentSelection((current) => resolveAgentSelection(current, enabledAgentNames));
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
      retryTimer = cancelPendingSseReconnect(retryTimer);
      source = closeSseSource(source);
    };
  }, [cachedSession, taskId, applyDetail, notifySidebarIfNeeded]);

  const scrollToBottom = useCallback((el: HTMLElement) => {
    el.scrollTo({
      top: clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight),
      behavior: "auto",
    });
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) scrollToBottom(el);
  }, [scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    stickRef.current = nextStickState(stickRef.current, el.scrollTop, prevTop, atBottom);
  }, []);

  // 現在のスクロール上端から見た前後方向のジャンプ先を求める。
  const navigationTargetAt = useCallback((direction: -1 | 1) => {
    const el = scrollRef.current;
    const ids = navigationMessageIdsRef.current;
    if (!el || ids.length === 0) return null;
    return messageNavigationTarget(
      ids.length,
      el.scrollTop + 4,
      (index) => messageElsRef.current.get(ids[index]!)?.offsetTop ?? Number.POSITIVE_INFINITY,
      direction,
    );
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
    stickRef.current = true;
  }, []);

  useLayoutEffect(() => {
    // A reused pane must not evaluate the previous task's messages as a
    // resumable turn while its first server snapshot is still pending.
    modelChangeRef.current += 1;
    titleMutationRef.current += 1;
    setTitleEditing(false);
    setTitleDraft("");
    setTitleBusy(false);
    titleCompletionPendingRef.current = false;
    titleUpdatedTurnRef.current = null;
    const cached = loadTaskSessionCache(taskId);
    setTask(cached);
    setMessages(cached?.messages ?? []);
    setContextUsage(cached?.contextUsage);
    setIsCompacting(Boolean(cached?.isCompacting));
    setWorktreeStatus(null);
    setPrompt("");
    setAttachments([]);
    const nextAutoRecord = readAutoTaskRecord(taskId);
    // Composer 既定の Auto はタスクへ持ち込まない。Auto 表示は当該タスクの Auto 記録があるときだけ。
    setModelSelection(nextAutoRecord ? AUTO_MODEL_VALUE : "");
    setAutoRecord(nextAutoRecord);
    setAutoRetryNotice(null);
    setAutoRetrying(false);
    autoRetryStatusRef.current = cached?.status;
    setGoalLoopEnabled(false);
    setGoalLoopAcceptance("");
    setGoalLoopMaxTurns(10);
    setGoalLoopCooldownSeconds(0);
    setGoalLoopForceFullRun(false);
    setSessionHydrating(true);
    setRevertConfirmOpen(false);
    setRevertBusy(false);
    revertEntryRef.current = null;
    setQueuedFollowUps([]);
    queuedSendRef.current = null;
    setQueuedAutoSend(false);
    setPendingUserMessage(null);
    setSubmitting(false);
    setResumingTurn(false);
    setResumeTurnError(null);
    setManualAbortedAssistantId(null);
    stopRequestedRef.current = false;
    setStopRequested(false);
    prevStatusWorkingRef.current = false;
    setHangRetryCount(0);
    setError(null);
    setPermissionRequest(null);
    setQuestionRequest(null);
    setPermissionBusy(false);
    setSkillPermission(cached?.skillPermission ?? readSkillPermission());
    setPermissionMode(cached?.permissionMode ?? readPermissionMode());
    const nextAgent = cached?.agent?.trim() || DEFAULT_AGENT;
    setAgent(nextAgent);
    // タスク切替時は当該タスクの agent を表示。Composer 既定 Auto や前タスクの Auto は引き継がない。
    setAgentSelection(nextAgent);
    autoResumeKeyRef.current = null;
    messageElsRef.current.clear();
    navigationMessageIdsRef.current = [];
    stickRef.current = true;
    lastScrollTopRef.current = 0;
  }, [taskId]);

  useLayoutEffect(() => {
    scheduleScrollToBottom();
  }, [messages, task?.isStreaming, isCompacting, scheduleScrollToBottom]);

  useEffect(() => {
    const perf = taskPerfRef.current;
    if (
      !TASK_PERF_ENABLED ||
      !perf ||
      sessionHydrating ||
      perf.readyAt === null ||
      perf.firstPaintAt !== null
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (perf.firstPaintAt !== null) return;
      const at = taskPerfNow();
      if (at === null) return;
      perf.firstPaintAt = at;
      taskPerfMark(perf.id, "first-paint");
      reportTaskPerformance(perf);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, sessionHydrating, taskId]);

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
    if (!canAttachComposerImages({ goalLoopEnabled, compacting: isCompacting, archived: task?.status === "archived" })) return;
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

  const compacting = isCompacting;
  const archived = task?.status === "archived";
  const statusWorking = task?.status === "working";
  const working = Boolean(statusWorking || task?.isStreaming);
  const isReverted = Boolean(task?.revertLeafId);

  useEffect(() => {
    const wasStatusWorking = prevStatusWorkingRef.current;
    prevStatusWorkingRef.current = Boolean(statusWorking);
    if (
      shouldClearStopRequestedOnWorkingTransition(
        wasStatusWorking,
        Boolean(statusWorking),
        stopRequestedRef.current,
      )
    ) {
      stopRequestedRef.current = false;
      setStopRequested(false);
    }
  }, [statusWorking]);

  // PartView は memo 化されており onRevert の参照比較でスキップ判定する。
  // inline arrow のままだと毎レンダー新参照になり、stabilizeUiMessages の
  // 参照安定化が無効化されるため useCallback で安定させる。
  const requestRevert = useCallback(
    (target: UiMessage) => {
      if (archived) {
        setError("アーカイブ済みのタスクは巻き戻せません");
        return;
      }
      if (working) {
        setError("実行中は巻き戻せません。停止してからお試しください");
        return;
      }
      revertEntryRef.current = { messageId: target.id, message: target };
      setRevertConfirmOpen(true);
    },
    [archived, working],
  );
  const goalLoopLive = Boolean(
    task?.goalLoop && ["queued", "running", "verifying_completed"].includes(task.goalLoop.status),
  );
  // 実行中・一時停止中のみパネルを表示。completed / blocked / stopped は
  // チャット側に結果が残るため閉じる（Sidebar の LIVE 判定と整合）。
  const goalLoopVisible = Boolean(
    task?.goalLoop &&
      ["queued", "running", "verifying_completed", "paused"].includes(task.goalLoop.status),
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
        onStatusRef.current?.(
          taskId,
          working ? "working" : task.status === "idle" ? next : task.status,
        );
      } catch {
        if (!closed) setWorktreeStatus(null);
      } finally {
        inFlight = false;
      }
    };

    setWorktreeStatus(null);
    void refreshWorktreeStatus();
    const onTasksChanged = () => void refreshWorktreeStatus();
    window.addEventListener("webui:tasks-changed", onTasksChanged);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshWorktreeStatus();
    }, 4_000);
    return () => {
      closed = true;
      window.removeEventListener("webui:tasks-changed", onTasksChanged);
      window.clearInterval(timer);
    };
  }, [active, task?.directory, task?.status, taskId, working]);

  useEffect(() => {
    if (titleTaskRef.current !== taskId) {
      titleTaskRef.current = taskId;
      previousWorkingRef.current = false;
      titleCompletionPendingRef.current = false;
      titleUpdatedTurnRef.current = null;
    }
    const wasWorking = previousWorkingRef.current;
    previousWorkingRef.current = working;
    if (wasWorking && !working) titleCompletionPendingRef.current = true;
    if (working) {
      titleCompletionPendingRef.current = false;
      return;
    }
    if (
      !titleCompletionPendingRef.current ||
      !task?.sessionId ||
      !resolveTitleAutoUpdateEnabled(task.titleAutoUpdate, titleAutoUpdateDefault) ||
      !hasCompletedTitleTurn(messages)
    ) return;
    titleCompletionPendingRef.current = false;
    let turnCount = 0;
    let lastUserMessageId: string | null = null;
    for (const message of messages) {
      if (message.role !== "user" || isHangRetryUserMessage(message)) continue;
      turnCount += 1;
      lastUserMessageId = message.id;
    }
    if (
      !lastUserMessageId ||
      !shouldAutoUpdateTitle(turnCount, titleUpdateFrequency) ||
      titleUpdatedTurnRef.current === lastUserMessageId
    ) return;
    titleUpdatedTurnRef.current = lastUserMessageId;
    const mutation = ++titleMutationRef.current;
    setTitleBusy(true);
    void sendJson<{ title: string; task: TaskSummary }>(`/api/tasks/${taskId}/title`, {}).then((result) => {
      if (mutation !== titleMutationRef.current) return;
      setTask((current) =>
        current && resolveTitleAutoUpdateEnabled(current.titleAutoUpdate, titleAutoUpdateDefault)
          ? { ...current, title: result.title }
          : current,
      );
      notifyTasksChanged();
    }).catch(() => undefined).finally(() => {
      if (mutation === titleMutationRef.current) setTitleBusy(false);
    });
  }, [messages, task?.sessionId, task?.titleAutoUpdate, taskId, titleAutoUpdateDefault, titleUpdateFrequency, working]);

  function beginTitleEdit() {
    if (!task || archived || titleBusy) return;
    setError(null);
    setTitleDraft(task.title);
    setTitleEditing(true);
  }

  function cancelTitleEdit() {
    if (titleBusy) return;
    setTitleEditing(false);
    setTitleDraft("");
  }

  async function saveTitle() {
    const value = titleDraft.trim();
    if (!value) {
      setError("タイトルを入力してください");
      return;
    }
    if (!task || archived || titleBusy) return;
    const mutation = ++titleMutationRef.current;
    setTitleBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ title: string; task: TaskSummary }>(
        `/api/tasks/${taskId}/title`,
        { title: value },
        "PATCH",
      );
      if (mutation !== titleMutationRef.current) return;
      setTask((current) => (current ? { ...current, ...result.task } : current));
      setTitleDraft(result.task.title);
      setTitleEditing(false);
      notifyTasksChanged();
    } catch (err) {
      if (mutation === titleMutationRef.current) {
        setError(err instanceof Error ? err.message : "タイトルの更新に失敗しました");
      }
    } finally {
      if (mutation === titleMutationRef.current) setTitleBusy(false);
    }
  }

  async function toggleTitleAutoUpdate() {
    if (!task || archived || titleBusy) return;
    const mutation = ++titleMutationRef.current;
    const enabled = resolveTitleAutoUpdateEnabled(task.titleAutoUpdate, titleAutoUpdateDefault);
    setTitleBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ title: string; task: TaskSummary }>(
        `/api/tasks/${taskId}/title`,
        { titleAutoUpdate: !enabled },
        "PATCH",
      );
      if (mutation !== titleMutationRef.current) return;
      setTask((current) => (current ? { ...current, ...result.task } : current));
      notifyTasksChanged();
    } catch (err) {
      if (mutation === titleMutationRef.current) {
        setError(err instanceof Error ? err.message : "タイトル自動更新の変更に失敗しました");
      }
    } finally {
      if (mutation === titleMutationRef.current) setTitleBusy(false);
    }
  }

  async function revert() {
    const target = revertEntryRef.current;
    if (!target || revertBusy || working || archived) return;
    setRevertBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskDetail; text: string; images: ComposerAttachment[] }>(
        `/api/tasks/${taskId}/revert`,
        { entryId: target.messageId },
      );
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
    if (revertBusy || archived) return;
    setRevertBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskDetail }>(
        `/api/tasks/${taskId}/unrevert`,
        {},
      );
      applyDetail(result.task);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "巻き戻しの取り消しに失敗しました");
    } finally {
      setRevertBusy(false);
    }
  }

  async function submit(queued?: QueuedFollowUp) {
    const submittedPrompt = queued ? queued.text : prompt;
    const submittedAttachments = queued ? queued.attachments : attachments;
    if (
      (!submittedPrompt.trim() && submittedAttachments.length === 0) ||
      submitting ||
      resumingTurn ||
      compacting ||
      agentChanging ||
      archived
    ) {
      return;
    }
    let draftCleared = false;
    if (
      !queued &&
      shouldQueueFollowUp({
        working,
        deliveryMode,
        goalLoopEnabled,
        goalLoopLive,
      })
    ) {
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
    if (working && (goalLoopEnabled || goalLoopLive)) {
      setError("Goal loop の実行中は追加の送信はできません");
      return;
    }
    const wasStopped = stopRequestedRef.current;
    stopRequestedRef.current = false;
    setStopRequested(false);
    setSubmitting(true);
    setError(null);
    try {
      const images = submittedAttachments
        .map((attachment) => {
          const comma = attachment.uri.indexOf(",");
          if (comma < 0) return null;
          return { mimeType: attachment.mime, data: attachment.uri.slice(comma + 1) };
        })
        .filter((item): item is { mimeType: string; data: string } => item !== null);
      const isAuto = modelValue === AUTO_MODEL_VALUE;
      let resolvedAgent: string | null | undefined;
      let resolvedAutoDecision: AutoDecision | undefined;
      if (goalLoopEnabled) {
        if (images.length > 0) throw new Error("Goal loop の開始では画像添付は使えません");
        setPrompt("");
        setAttachments([]);
        draftCleared = true;
        const result = await sendJson<{
          loop: GoalLoopDto | null;
          agent?: string | null;
          autoDecision?: AutoDecision;
        }>(
          `/api/tasks/${taskId}/goal-loop`,
          {
            action: "start",
            goal: prompt,
            acceptance: goalLoopAcceptance,
            maxTurns: goalLoopMaxTurns,
            cooldownSeconds: goalLoopCooldownSeconds,
            forceFullRun: goalLoopForceFullRun,
            ...(agentSelection ? { agent: agentSelection } : {}),
            ...(isAuto
              ? {
                  auto: true,
                  autoOptimize: autoOptimizeMode,
                  autoRouteOverrides: autoRouteConfig,
                }
              : {}),
          },
        );
        resolvedAgent = result.agent;
        resolvedAutoDecision = result.autoDecision;
        setGoalLoopEnabled(false);
      } else {
        // working covers prompt_accepted→stream gap; isStreaming alone misses it
        // and would POST a normal chained prompt instead of steer.
        const isSteer = shouldSendSteerBehavior({ working, deliveryMode });
        const optimisticId = `optimistic:${taskId}:${nextOptimisticMessageIdRef.current++}`;
        const optimisticMessage: UiMessage = {
          id: optimisticId,
          role: "user",
          createdAt: Date.now(),
          parts: [],
        };
        if (submittedPrompt.trim()) {
          optimisticMessage.parts.push({
            id: `${optimisticId}:text`,
            type: "text",
            text: submittedPrompt,
          });
        }
        submittedAttachments.forEach((attachment, index) => {
          optimisticMessage.parts.push({
            id: `${optimisticId}:image:${index}`,
            type: "image",
            url: attachment.uri,
            mime: attachment.mime,
            filename: attachment.name,
          });
        });
        // Steer does not append a user message to history, so an optimistic
        // row would never clear via baselineUserCount and would ghost forever.
        if (
          shouldShowOptimisticPendingUser({
            working,
            deliveryMode,
          })
        ) {
          setPendingUserMessage({
            message: optimisticMessage,
            baselineUserCount: messages.filter((message) => message.role === "user").length,
          });
        }
        if (!queued) {
          setPrompt("");
          setAttachments([]);
          draftCleared = true;
        }
        const result = await sendJson<{
          task: TaskSummary;
          autoDecision?: AutoDecision;
        }>(`/api/tasks/${taskId}/prompt`, {
          prompt: submittedPrompt,
          images,
          ...(isAuto
            ? {
                auto: true,
                autoOptimize: autoOptimizeMode,
                autoRouteOverrides: autoRouteConfig,
              }
            : {}),
          ...(agentSelection ? { agent: agentSelection } : {}),
          subagentPermission,
          ...(isSteer ? { streamingBehavior: "steer" } : {}),
        });
        resolvedAgent = result.task.agent ?? null;
        resolvedAutoDecision = result.autoDecision;
        setTask((current) => (current ? { ...current, ...result.task } : current));
      }
      if (isAuto && resolvedAutoDecision) {
        const nextRecord: AutoTaskRecord = {
          decision: resolvedAutoDecision,
          ...(!images.length && submittedPrompt.length <= AUTO_TASK_PROMPT_MAX
            ? { prompt: submittedPrompt }
            : {}),
          ...(resolvedAgent?.trim() ? { agent: resolvedAgent.trim() } : {}),
        };
        writeAutoTaskRecord(taskId, nextRecord);
        setAutoRecord(nextRecord);
      }
      if (resolvedAgent !== undefined) {
        const nextAgent = resolvedAgent?.trim() || DEFAULT_AGENT;
        setAgent(nextAgent);
        setAgentSelection(
          agentSelection === AUTO_AGENT_VALUE ? AUTO_AGENT_VALUE : nextAgent,
        );
      }
      // The composer is editable during the request; do not clear its next draft.
      notifyTasksChanged();
    } catch (err) {
      if (wasStopped) {
        stopRequestedRef.current = true;
        setStopRequested(true);
      }
      if (queued && !stopRequestedRef.current) {
        setPendingUserMessage(null);
        setQueuedFollowUps((current) => [queued, ...current]);
      }
      if (draftCleared) {
        setPendingUserMessage(null);
        setPrompt((current) => current || submittedPrompt);
        setAttachments((current) =>
          current.length > 0 ? current : submittedAttachments,
        );
      }
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }
  submitRef.current = submit;

  useEffect(() => {
    const previousStatus = autoRetryStatusRef.current;
    const currentStatus = task?.status;
    autoRetryStatusRef.current = currentStatus;
    const escalation = autoRecord?.decision.escalation;
    // Message deltas are frequent; only scan the full history on an eligible error transition.
    if (
      previousStatus === undefined ||
      previousStatus === "error" ||
      currentStatus !== "error" ||
      task?.limitError === true ||
      !escalation ||
      autoRecord?.retried ||
      !autoRecord?.prompt ||
      autoRetrying
    ) {
      return;
    }
    const userMessages = messages.filter((message) => message.role === "user");
    const hasCompletedAssistant = messages.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "text" && part.text.trim()),
    );
    if (
      !shouldAutoRetryEscalate({
        previousStatus,
        currentStatus,
        limitError: false,
        hasEscalation: Boolean(escalation),
        retried: autoRecord?.retried,
        hasPrompt: Boolean(autoRecord?.prompt),
        autoRetrying,
        userMessageCount: userMessages.length,
        hasCompletedAssistantText: hasCompletedAssistant,
      })
    ) {
      return;
    }
    if (!autoRecord || !escalation || !autoRecord.prompt) return;

    const nextRecord: AutoTaskRecord = { ...autoRecord, retried: true };
    if (!writeAutoTaskRecord(taskId, nextRecord)) return;
    setAutoRecord(nextRecord);
    setAutoRetrying(true);
    const retryNotice = "低コストモデルでエラーが発生したため上位候補で再試行しました";
    const retryThinkingLevel = autoVariantToThinkingLevel(escalation.variant);
    void sendJson(`/api/tasks/${taskId}/prompt`, {
      prompt: autoRecord.prompt,
      auto: true,
      autoRetry: true,
      model: autoModelValue(escalation),
      ...(retryThinkingLevel ? { thinkingLevel: retryThinkingLevel } : {}),
      ...(autoRecord.agent ? { agent: autoRecord.agent } : {}),
      subagentPermission,
    })
      .then(() => {
        setAutoRetryNotice(retryNotice);
        setError(null);
        notifyTasksChanged();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Auto 再試行に失敗しました");
      })
      .finally(() => setAutoRetrying(false));
  }, [
    autoRecord,
    autoRetrying,
    messages,
    subagentPermission,
    task?.limitError,
    task?.status,
    taskId,
  ]);

  useEffect(() => {
    if (
      error ||
      agentChanging ||
      archived ||
      !shouldDrainQueuedFollowUp({
        working,
        submitting,
        queuedAutoSend,
        goalLoopEnabled,
        goalLoopLive,
        stopRequested,
        hasQueuedItem: queuedFollowUps.length > 0,
        resumingTurn,
        sessionHydrating,
        sseReconnecting,
        compacting,
      })
    ) {
      return;
    }
    const next = queuedFollowUps[0];
    if (!next) return;
    setQueuedFollowUps((current) => current.filter((item) => item.id !== next.id));
    // Keep queue payloads separate from the editable composer and its delivery mode.
    queuedSendRef.current = next;
    setQueuedAutoSend(true);
  }, [
    error,
    agentChanging,
    archived,
    compacting,
    goalLoopEnabled,
    goalLoopLive,
    queuedAutoSend,
    queuedFollowUps,
    resumingTurn,
    sessionHydrating,
    sseReconnecting,
    stopRequested,
    submitting,
    working,
  ]);

  useEffect(() => {
    if (
      !shouldAutoSendQueuedFollowUp({
        queuedAutoSend,
        working,
        submitting,
        goalLoopEnabled,
        goalLoopLive,
        stopRequested,
        hasContent: Boolean(queuedSendRef.current),
        resumingTurn,
        sessionHydrating,
        sseReconnecting,
        compacting,
      })
    ) {
      if (queuedAutoSend && !queuedSendRef.current) {
        setQueuedAutoSend(false);
      }
      return;
    }
    if (agentChanging || archived) return;
    const queued = queuedSendRef.current;
    queuedSendRef.current = null;
    setQueuedAutoSend(false);
    if (queued) void submitRef.current(queued);
  }, [
    agentChanging,
    archived,
    attachments.length,
    compacting,
    goalLoopEnabled,
    goalLoopLive,
    prompt,
    queuedAutoSend,
    resumingTurn,
    sessionHydrating,
    sseReconnecting,
    stopRequested,
    submitting,
    working,
  ]);

  async function goalLoopAction(action: "pause" | "resume" | "stop" | "complete", maxTurns?: number) {
    if (archived) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendJson<{ loop: GoalLoopDto | null }>(
        `/api/tasks/${taskId}/goal-loop`,
        { action, ...(maxTurns !== undefined ? { maxTurns } : {}) },
        "PATCH",
      );
      if (action === "resume") {
        // Prior Stop left stopRequested latched; resume starts a new run.
        stopRequestedRef.current = false;
        setStopRequested(false);
      }
      setTask((current) => (current ? { ...current, goalLoop: result.loop } : current));
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Goal loop の操作に失敗しました");
    } finally {
      setSubmitting(false);
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
    if (archived || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setStopRequested(true);
    // stopRequested already blocks drain/auto-send. Clear client-only queues only
    // after abort succeeds so a failed stop does not drop queued follow-ups.
    try {
      setError(null);
      const result = await sendJson<{ task: TaskSummary }>(`/api/tasks/${taskId}/abort`, {});
      setQueuedFollowUps([]);
      queuedSendRef.current = null;
      setQueuedAutoSend(false);
      setPendingUserMessage(null);
      // TaskSummary does not include the live-session flag. Clear it here so
      // one successful stop cannot leave the local `working` state stale.
      setTask((current) =>
        current ? { ...current, ...result.task, isStreaming: false } : current,
      );
      notifyTasksChanged();
    } catch (err) {
      stopRequestedRef.current = false;
      setStopRequested(false);
      setError(err instanceof Error ? err.message : "停止に失敗しました");
    }
  }

  const resumeTurn = useCallback(async (target: ResumableTurn, manual = false) => {
    if (working || resumingTurn || archived) return;
    const wasStopped = stopRequestedRef.current;
    if (manual) {
      stopRequestedRef.current = false;
      setStopRequested(false);
    }
    setResumeTurnError(null);
    setResumingTurn(true);
    stickRef.current = true;
    try {
      const resumeMode = readAutoResumeMode();
      const images = shouldAttachResumeImages(resumeMode, target.text, target.files.length)
        ? target.files
            .map((file) => {
              const comma = file.uri.indexOf(",");
              if (comma < 0) return null;
              return { mimeType: file.mime, data: file.uri.slice(comma + 1) };
            })
            .filter((item): item is { mimeType: string; data: string } => item !== null)
        : [];
      await sendJson(`/api/tasks/${taskId}/prompt`, {
        prompt: autoResumePrompt(resumeMode, target.text),
        images,
        resume: true,
        ...(target.model
          ? {
              model: target.model.accountId
                ? `${target.model.accountId}::${target.model.providerID}::${target.model.modelID}`
                : `${target.model.providerID}::${target.model.modelID}`,
            }
          : {}),
        subagentPermission,
      });
      setManualAbortedAssistantId(null);
      notifyTasksChanged();
    } catch (err) {
      if (manual && wasStopped) {
        stopRequestedRef.current = true;
        setStopRequested(true);
      }
      setResumeTurnError(err instanceof Error ? err.message : "再開に失敗しました");
    } finally {
      setResumingTurn(false);
    }
  }, [archived, resumingTurn, subagentPermission, taskId, working]);

  // タスクのアカウントを切替えるモデルも選べる（setTaskModel が再作成を担う）ため
  // 他アカウントのモデルも含めて全候補を出す。並び順は /api/models の providerOrder 準拠。
  const plainTaskModelValue =
    task?.providerID && task.modelID ? `${task.providerID}::${task.modelID}` : "";
  const accountTaskModel = task?.accountId
    ? models.find(
        (option) =>
          option.accountId === task.accountId &&
          option.providerID === task.providerID &&
           option.modelID === task.modelID,
       )
     : undefined;
  const modelOptions = useMemo(() => [AUTO_MODEL_OPTION, ...models], [models]);
  const modelValue = resolveModelValue({
    modelSelection,
    hasAutoRecord: Boolean(autoRecord),
    accountTaskModelValue: accountTaskModel?.value,
    plainTaskModelValue,
    firstModelValue: models[0]?.value,
  });
  const selectedModel =
    modelValue === AUTO_MODEL_VALUE
      ? AUTO_MODEL_OPTION
      : modelOptionForValue(models, modelValue);
  const thinkingLevels = useMemo(
    () => selectedModel?.thinkingLevels ?? [],
    [selectedModel],
  );
  const thinkingValue: ThinkingLevel = resolveThinkingLevel(thinkingLevels, task?.thinkingLevel);
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
  // ナビゲーターのジャンプ対象: ユーザーメッセージを優先し、Goal Loop の
  // hidden custom message しかない履歴では投影済みメッセージへフォールバックする。
  // 表示用フィルタとヘッダー統計も同じ走査で集計し、deltaごとの履歴再走査を抑える。
  const {
    visibleMessages,
    detectedHangRetryCount,
    userMessageIds,
    navigationMessageIds,
    stats,
    lastUserMessage,
    currentPromptIsHangRetry,
  } = useMemo(() => {
    const visible: UiMessage[] = [];
    const userIds: string[] = [];
    const fallbackIds: string[] = [];
    let detectedHangRetryCount = 0;
    let totalTokens = 0;
    let rateSum = 0;
    let rateCount = 0;
    let durationMs = 0;
    let prevCreatedAt: number | null = null;
    let lastUserMessage: UiMessage | undefined;
    let currentPromptIsHangRetry = false;
    for (const message of messages) {
      const hangRetry = isHangRetryUserMessage(message);
      if (message.role === "user") {
        lastUserMessage = message;
        currentPromptIsHangRetry = hangRetry;
      }
      if (hangRetry) {
        detectedHangRetryCount += 1;
        continue;
      }
      visible.push(message);
      if (message.role === "user") userIds.push(message.id);
      else if (message.role !== "compaction") fallbackIds.push(message.id);
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
      visibleMessages: visible,
      detectedHangRetryCount,
      userMessageIds: userIds,
      navigationMessageIds: userIds.length > 0 ? userIds : fallbackIds,
      lastUserMessage,
      currentPromptIsHangRetry,
      stats: {
        totalTokens,
        avgRate,
        durationMs: messages.length > 1 ? durationMs : 0,
      },
    };
  }, [messages]);
  const pendingUserDelivered = Boolean(
    pendingUserMessage && userMessageIds.length > pendingUserMessage.baselineUserCount,
  );
  const renderedMessages = useMemo(
    () =>
      pendingUserMessage && !pendingUserDelivered
        ? [...visibleMessages, pendingUserMessage.message]
        : visibleMessages,
    [pendingUserDelivered, pendingUserMessage, visibleMessages],
  );
  useEffect(() => {
    if (pendingUserDelivered) setPendingUserMessage(null);
  }, [pendingUserDelivered]);
  const resumeTarget = useMemo(
    () =>
      working
        ? null
        : findResumableTurn(visibleMessages, {
            manualAbortedAssistantId,
          }),
    [visibleMessages, manualAbortedAssistantId, working],
  );
  const showResume =
    active &&
    !!resumeTarget &&
    !!task &&
    !sessionHydrating &&
    !compacting &&
    !sseReconnecting &&
    !working &&
    !archived &&
    !goalLoopLive;
  const autoResumeSilentTurn = shouldAutoResumeSilentTurn({
    target: resumeTarget,
    showResume,
    active,
    sessionHydrating,
    compacting,
    sseReconnecting,
    taskStatus: task?.status,
    stopRequested,
    resumingTurn,
    currentPromptIsHangRetry,
    hasQueuedFollowUp: queuedFollowUps.length > 0,
    queuedAutoSend,
  });
  useEffect(() => {
    if (!autoResumeSilentTurn || !resumeTarget) return;
    const key = `${taskId}:${resumeTarget.messageId}`;
    if (autoResumeKeyRef.current === key) return;
    autoResumeKeyRef.current = key;
    void resumeTurn(resumeTarget);
  }, [autoResumeSilentTurn, currentPromptIsHangRetry, resumeTarget, resumeTurn, resumingTurn, showResume, task?.status, taskId]);
  const resumeMessage = resumeTarget
    ? visibleMessages.find((message) => message.id === resumeTarget.messageId)
    : undefined;
  const resumeErrorText = resumeTarget ? resumeMessage?.error ?? "" : "";
  const resumeInsideExistingBanner =
    !!resumeTarget &&
    resumeTarget.reason === "aborted" &&
    !!resumeErrorText &&
    !!resumeMessage;
  const messageBlocks = useMemo(
    () =>
      taskMessageBlocks(
        renderedMessages,
        resumeInsideExistingBanner ? resumeTarget?.messageId : undefined,
      ),
    [renderedMessages, resumeInsideExistingBanner, resumeTarget?.messageId],
  );
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
        onClick={() => void resumeTurn(resumeTarget, true)}
      >
        {!resumingTurn && <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />}
        {resumingTurn ? "再開中…" : "再開"}
      </Button>
    ) : null;
  const autoHangRetryCount = Math.max(hangRetryCount, detectedHangRetryCount);
  const hangRetryNotice =
    autoHangRetryCount > 0
      ? `応答が${formatHangTimeout(readHangTimeoutMs())}間止まったため自動的に停止し、設定した方法で再開しました${
          autoHangRetryCount > 1 ? `（${autoHangRetryCount}回）` : ""
        }`
      : null;
  const autoNotice = autoRetryNotice;
  function dismissAutoNotice() {
    setAutoRetryNotice(null);
  }
  const modelLabels = useMemo(
    () => Object.fromEntries(models.map((option) => [option.value, option.label])),
    [models],
  );
  // モデル一覧の読み込み状態に関係なく、タスクへ実際に保存されたeffortを表示する。
  const effortLabel = thinkingLevelMetaLabel(task?.thinkingLevel);

  const navigationTargetLabel = userMessageIds.length > 0 ? "ユーザーメッセージ" : "メッセージ";
  navigationMessageIdsRef.current = navigationMessageIds;

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
  const titleAutoUpdateEnabled = resolveTitleAutoUpdateEnabled(
    task?.titleAutoUpdate,
    titleAutoUpdateDefault,
  );
  const mobilePanelOpen = !mdUp && (graphOpen || diffOpen);

  return (
    // min-h-0 flex-1: ペイン section が TaskTabs を持つ場合でも残り高さに収める。
    // h-full だとタブバー分だけはみ出し composer 下端が overflow-hidden で欠ける。
    <div
      ref={taskViewRef}
      className={cx("@container/task flex min-h-0 min-w-0 flex-1 flex-col bg-bot-chat", !active && "hidden")}
    >
      <header
        className="grid min-h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-b border-bot-outline bg-bot-chat px-3 pb-0.5 @min-[48rem]/task:grid-cols-[minmax(0,1fr)_auto_auto] @min-[48rem]/task:px-4"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="col-span-2 flex min-w-0 items-center gap-2 @min-[48rem]/task:col-span-1">
          <MobileMenuButton />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              role="switch"
              aria-checked={titleAutoUpdateEnabled}
              aria-label="タイトルの自動更新"
              title={`タイトルの自動更新: ${titleAutoUpdateEnabled ? "ON" : "OFF"}（${titleUpdateFrequency}ターンごと）`}
              className={cx("hidden shrink-0 @min-[48rem]/task:inline-flex h-11 w-11 @min-[48rem]/task:h-9 @min-[48rem]/task:w-9", titleAutoUpdateEnabled && "text-accent!")}
              disabled={!task || archived || titleBusy}
              onClick={() => void toggleTitleAutoUpdate()}
            >
              <WandSparkles className="h-4 w-4" />
            </Button>
            {titleEditing ? (
              <form
                aria-label="セッションタイトルを編集"
                className="flex min-w-0 flex-1 items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveTitle();
                }}
              >
                <input
                  ref={titleInputRef}
                  value={titleDraft}
                  maxLength={TITLE_MAX_CHARS}
                  aria-label="セッションタイトル"
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelTitleEdit();
                    }
                  }}
                  className="h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-bg px-2 text-base font-semibold text-text outline-none focus:border-accent @min-[48rem]/task:h-8 @min-[48rem]/task:text-sm"
                  disabled={titleBusy}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 @min-[48rem]/task:h-8 @min-[48rem]/task:w-8"
                  type="submit"
                  aria-label="タイトルを保存"
                  title="タイトルを保存"
                  busy={titleBusy}
                  disabled={titleBusy}
                >
                  {!titleBusy && <Check className="h-4 w-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 @min-[48rem]/task:h-8 @min-[48rem]/task:w-8"
                  aria-label="タイトル編集をキャンセル"
                  title="キャンセル"
                  disabled={titleBusy}
                  onClick={cancelTitleEdit}
                >
                  <X className="h-4 w-4" />
                </Button>
              </form>
            ) : (
              <h1 className="min-w-0 flex-1 text-sm font-semibold" aria-label={task?.title ?? "読み込み中…"}>
                <button
                  type="button"
                  className="group/title flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg text-left disabled:cursor-default @min-[48rem]/task:min-h-8"
                  aria-label={`タイトルを編集: ${task?.title ?? "読み込み中…"}`}
                  title={task?.title}
                  disabled={!task || archived || titleBusy}
                  onClick={beginTitleEdit}
                >
                  <span className="truncate">{task?.title ?? "読み込み中…"}</span>
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted group-hover/title:text-accent" />
                </button>
              </h1>
            )}
          </div>
        </div>
        <div aria-label="タスクの状態" className="col-span-1 col-start-1 row-start-2 flex min-w-0 items-center gap-x-2 overflow-hidden text-xs text-muted @max-[48rem]/task:-translate-y-0.5 @min-[48rem]/task:col-span-1 @min-[48rem]/task:col-start-2 @min-[48rem]/task:row-start-1">
          {permissionRequest && <Badge tone="warning" className="shrink-0">承認待ち</Badge>}
          {questionRequest && <Badge tone="warning" className="shrink-0">回答待ち</Badge>}
          {displayedStatus && <StatusBadge status={displayedStatus} className="shrink-0" />}
          {contextUsage && <ContextUsageMeter usage={contextUsage} />}
          {stats.totalTokens > 0 && (
            <span
              className="hidden font-mono tabular-nums @min-[36rem]/task:inline"
              title={`合計 ${formatTokens(stats.totalTokens)} tok（出力のみ）`}
            >
              {formatTokens(stats.totalTokens)} tok
            </span>
          )}
          {stats.avgRate !== null && (
            <span
              className="hidden font-mono tabular-nums @min-[36rem]/task:inline"
              title="平均 tok/s（応答ごとの tok/s の平均）"
            >
              {formatTokensPerSecond(stats.avgRate)}
            </span>
          )}
          {stats.durationMs > 0 && (
            <span
              className="hidden font-mono tabular-nums @min-[36rem]/task:inline"
              title="合計生成時間（メッセージ間隔の累計）"
            >
              {formatDuration(stats.durationMs)}
            </span>
          )}
        </div>
        <div
          role="group"
          aria-label="タスク操作"
          className="flex items-center justify-end col-start-2 row-start-2 @min-[48rem]/task:col-start-3 @min-[48rem]/task:row-start-1"
        >
          {onAddPane && (
            <Button
              variant="ghost"
              size="icon"
              title="新しいペインを追加"
              aria-label="新しいペインを追加"
              className="h-11 w-11 @min-[48rem]/task:h-9 @min-[48rem]/task:w-9 @max-[48rem]/task:hidden"
              onClick={onAddPane}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
          <ProjectExplorerButton
            projectId={task?.projectId}
            taskId={task?.id}
            onError={setError}
          />
          <Button
            variant="ghost"
            size="icon"
            title="コミットグラフ"
            aria-label="コミットグラフ"
            aria-pressed={graphOpen}
            disabled={!task}
            className={cx(
              "h-11 w-11 @min-[48rem]/task:h-9 @min-[48rem]/task:w-9",
              graphOpen && "bg-surface-2 text-text",
            )}
            onClick={() =>
              setPanelState((current) =>
                toggleTaskPanel(current, "graph", panelsCanBeSimultaneous),
              )
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
              "h-11 w-11 @min-[48rem]/task:h-9 @min-[48rem]/task:w-9",
              diffOpen && "bg-surface-2 text-text",
            )}
            onClick={() =>
              setPanelState((current) =>
                toggleTaskPanel(current, "diff", panelsCanBeSimultaneous),
              )
            }
          >
            <PanelRight className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cx(
            "min-h-0 min-w-0 flex-1 overscroll-y-contain overflow-x-clip overflow-y-auto bg-bot-chat px-3 py-5 sm:px-4",
            mobilePanelOpen && "hidden",
          )}
        >
          <div ref={contentRef} className="relative mx-auto flex w-full min-w-0 max-w-5xl flex-col space-y-6">
            {hangRetryNotice && (
              <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                {hangRetryNotice}
              </p>
            )}
            {autoNotice && (
              <TurnNoticeBanner
                message={autoNotice}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Auto選定通知を閉じる"
                    onClick={dismissAutoNotice}
                  >
                    閉じる
                  </Button>
                }
                tone="neutral"
              />
            )}
            {messageBlocks.map((block) => {
              const firstMessage = block.kind === "tool-group" ? block.entries[0]!.message : block.message;
              const turn =
                block.kind === "tool-group"
                  ? block.showTurnDivider
                    ? firstMessage.goalLoopTurn
                    : undefined
                  : isGoalLoopTurnBoundary(renderedMessages, block.index)
                    ? firstMessage.goalLoopTurn
                    : undefined;
              const messageHeaders =
                block.kind === "tool-group"
                  ? block.entries
                      .filter((entry) => entry.showHeader)
                      .map((entry) => {
                        const message = entry.message;
                        return (
                          <MessageMetaHeader
                            key={`task-tool-message-meta:${messageRenderKey(message)}`}
                            message={message}
                            modelLabel={
                              message.provider && message.model
                                ? modelLabels[`${message.provider}::${message.model}`]
                                : undefined
                            }
                            effort={effortLabel}
                            agent={task?.agent ?? undefined}
                            accountLabel={
                              message.accountId
                                ? (accountLabels.get(message.accountId) ?? message.accountId)
                                : (taskAccountLabel ?? undefined)
                            }
                          />
                        );
                      })
                  : [];
              const activityContents =
                block.kind === "tool-group"
                  ? block.entries.flatMap((entry) => {
                      const message = entry.activityMessage;
                      const toolParts = message.parts.filter(
                        (part): part is TaskToolPart => part.type === "tool",
                      );
                      if (
                        toolParts.length === message.parts.length &&
                        toolParts.length > 0 &&
                        !message.error &&
                        (message.diagnostics?.length ?? 0) === 0
                      ) {
                        return toolParts.map((part) => {
                          const partKey = part.id || part.callID;
                          const cardKey =
                            part.state.status === "error" || part.state.status === "cancelled"
                              ? `${partKey}:expanded`
                              : partKey;
                          return (
                            <ToolCard
                              key={`task-tool-part:${cardKey}`}
                              part={part}
                              taskId={taskId}
                              tabActive={active}
                            />
                          );
                        });
                      }
                      return [
                        <PartView
                          key={`task-tool-message:${messageRenderKey(entry.message)}`}
                          message={message}
                          modelLabel={
                            message.provider && message.model
                              ? modelLabels[`${message.provider}::${message.model}`]
                              : undefined
                          }
                          effort={effortLabel}
                          agent={task?.agent ?? undefined}
                          accountLabel={
                            message.accountId
                              ? (accountLabels.get(message.accountId) ?? message.accountId)
                              : (taskAccountLabel ?? undefined)
                          }
                          references={messageReferences}
                          taskId={taskId}
                          active={active}
                          hideMeta
                        />,
                      ];
                    })
                  : [];
              const activityCount =
                block.kind === "tool-group"
                  ? block.entries.reduce((count, entry) => count + taskActivityCount(entry), 0)
                  : 0;
              return (
                <div
                  key={
                    block.kind === "tool-group"
                      ? `task-tool-group:${messageRenderKey(firstMessage)}`
                      : messageRenderKey(block.message)
                  }
                  className="task-message-row"
                  ref={(el) => {
                    const messagesToTrack =
                      block.kind === "tool-group"
                        ? block.entries.filter((entry) => entry.showHeader).map((entry) => entry.message)
                        : [block.message];
                    for (const message of messagesToTrack) {
                      if (el) messageElsRef.current.set(message.id, el);
                      else messageElsRef.current.delete(message.id);
                    }
                  }}
                >
                  {turn && <GoalLoopTurnDivider turn={turn} />}
                  {block.kind === "tool-group" ? (
                    <TaskToolActivityGroup
                      messageHeaders={messageHeaders}
                      contents={activityContents}
                      count={activityCount}
                    />
                  ) : showResume &&
                    resumeInsideExistingBanner &&
                    resumeTarget?.messageId === block.message.id ? (
                    <TurnNoticeBanner
                      message={resumeBannerText}
                      action={resumeAction}
                      actionError={resumeTurnError}
                      tone="danger"
                    />
                  ) : (
                    <PartView
                      message={block.message}
                      modelLabel={
                        block.message.provider && block.message.model
                          ? modelLabels[`${block.message.provider}::${block.message.model}`]
                          : undefined
                      }
                      effort={block.message.role === "assistant" ? effortLabel : undefined}
                      agent={block.message.role === "assistant" ? task?.agent ?? undefined : undefined}
                      accountLabel={
                        block.message.role === "assistant"
                          ? block.message.accountId
                            ? (accountLabels.get(block.message.accountId) ?? block.message.accountId)
                            : (taskAccountLabel ?? undefined)
                          : undefined
                      }
                      bot={block.message.role === "user" ? botFor?.(task?.botId) : undefined}
                      references={messageReferences}
                      taskId={taskId}
                      active={active}
                      onRevert={block.message.role === "user" ? requestRevert : undefined}
                    />
                  )}
                </div>
              );
            })}
            {showResume && !resumeInsideExistingBanner && resumeTarget && (
              <TurnNoticeBanner
                message={resumeBannerText}
                action={resumeAction}
                actionError={resumeTurnError}
                tone={resumeTarget.reason === "silent" ? "neutral" : "danger"}
              />
            )}
            {working && <WorkingRow messages={renderedMessages} active={active} />}
            {task?.todos && <TodoProgressPanel todos={task.todos} />}
            {goalLoopVisible && !archived && (
              <GoalLoopPanel
                loop={task?.goalLoop}
                busy={submitting}
                onAction={(action) => void goalLoopAction(action)}
                onResume={(maxTurns) => void goalLoopAction("resume", maxTurns)}
              />
            )}
            {renderedMessages.length === 0 && (
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
                    const target = navigationTargetAt(-1);
                    if (target !== null) jumpToMessage(target);
                  },
                  <ChevronUp key="i" className="h-4 w-4" />,
                ],
                [
                  `一つ後の${navigationTargetLabel}へ`,
                  () => {
                    const target = navigationTargetAt(1);
                    if (target === null) {
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
          <SidePanel
            storageKey="webui.graphpanel.width"
            onWidthChange={onGraphPanelWidthChange}
          >
            <GraphPanel directory={task.directory} working={working} active={active} />
          </SidePanel>
        )}
        {diffOpen && task?.directory && (
          <SidePanel
            storageKey="webui.diffpane.width"
            onWidthChange={onDiffPanelWidthChange}
          >
            <DiffPane
              directory={task.directory}
              agent={task.agent?.trim() || undefined}
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
        "shrink-0 bg-bot-chat px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-4",
        mobilePanelOpen && "hidden",
      )}>
        {permissionRequest && (
          <div
            role="alertdialog"
            aria-label="危険なコマンドの確認"
            className="mx-auto mb-2 max-w-5xl rounded-lg border border-warning/30 bg-warning-bg px-3 py-3 text-sm text-warning"
          >
            <p className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{permissionRequest.message}</p>
            {permissionRequest.labels.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                検出: {permissionRequest.labels.join(", ")}
              </p>
            )}
            <pre className="mt-2 max-h-32 overflow-auto rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground">
              {permissionRequest.command}
            </pre>
            <PermissionAdvice taskId={taskId} requestId={permissionRequest.id} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                busy={permissionBusy}
                disabled={permissionBusy}
                onClick={() => {
                  const answeredId = permissionRequest.id;
                  void (async () => {
                    try {
                      setPermissionBusy(true);
                      setError(null);
                      await sendJson(`/api/tasks/${taskId}/permission`, {
                        requestId: answeredId,
                        approved: true,
                      });
                      setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
                    } catch (err) {
                      const message = err instanceof Error ? err.message : "許可の送信に失敗しました";
                      setError(message);
                      if (/not found|見つかりません/i.test(message)) {
                        setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
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
                  const answeredId = permissionRequest.id;
                  void (async () => {
                    try {
                      setPermissionBusy(true);
                      setError(null);
                      await sendJson(`/api/tasks/${taskId}/permission`, {
                        requestId: answeredId,
                        approved: false,
                      });
                      setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
                    } catch (err) {
                      const message = err instanceof Error ? err.message : "拒否の送信に失敗しました";
                      setError(message);
                      if (/not found|見つかりません/i.test(message)) {
                        setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
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
                const answeredId = request.id;
                setError(null);
                try {
                  await sendJson(`/api/tasks/${taskId}/question`, {
                    requestId: answeredId,
                    answers,
                  });
                  setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                } catch (err) {
                  const message = err instanceof Error ? err.message : "回答の送信に失敗しました";
                  if (/not found|見つかりません/i.test(message)) {
                    setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                  }
                  throw err;
                }
              }}
              onReject={async (request) => {
                const answeredId = request.id;
                setError(null);
                try {
                  await sendJson(`/api/tasks/${taskId}/question`, {
                    requestId: answeredId,
                    reject: true,
                  });
                  setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                } catch (err) {
                  const message = err instanceof Error ? err.message : "拒否の送信に失敗しました";
                  if (/not found|見つかりません/i.test(message)) {
                    setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                  }
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
        {goalLoopEnabled && !archived && (
          <div className="mx-auto max-w-5xl">
            <GoalLoopOptions
              acceptance={goalLoopAcceptance}
              maxTurns={goalLoopMaxTurns}
              cooldownSeconds={goalLoopCooldownSeconds}
              forceFullRun={goalLoopForceFullRun}
              disabled={submitting || working || archived}
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
        <Composer
          form={{
            ariaLabel: "フォローアップ",
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
          attachmentRemovalDisabled={archived}
          textarea={{
            ref: textareaRef,
            value: prompt,
            rows: 1,
            ariaLabel: "フォローアップ",
            onChange: (event) => setPrompt(event.target.value),
            onValueChange: setPrompt,
            onPaste: (event) => {
              // 添付不可でも画像ペーストは検出して preventDefault する。
              // 早期 return すると textarea へ画像が落ちる。
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
            placeholder: archived
              ? "アーカイブ済み（読み取り専用）"
              : compacting
                ? "圧縮中です…"
                : working
                  ? deliveryMode === "queue"
                    ? "実行中です。送信するとキューに追加します…"
                    : "実行中です。送信すると現在の処理へ割り込みます…"
                  : "続きを指示…（Ctrl+Enter）",
            className: "w-full min-h-11 resize-none bg-transparent py-2.5 text-base leading-6 outline-none placeholder:text-faint",
            disabled: compacting || archived,
          }}
          references={{ skills, agents }}
          attachmentControl={{
            inputRef: fileInputRef,
            inputDisabled: !canAttachComposerImages({ goalLoopEnabled, compacting, archived }),
            buttonDisabled: !canAttachComposerImages({ goalLoopEnabled, compacting, archived }),
            buttonTitle: "画像を添付",
            onFilesSelected: addImageFiles,
            onTrigger: () => fileInputRef.current?.click(),
          }}
          settingsGroups={[
            {
              id: "execution",
              label: "実行設定",
              content: (
                <>
              <ModelSelect
                value={modelValue}
                options={modelOptions}
                disabled={compacting || archived}
                loading={modelsLoading}
                onChange={(value) => {
                  const changeId = ++modelChangeRef.current;
                  if (value === AUTO_MODEL_VALUE) {
                    setModelSelection(AUTO_MODEL_VALUE);
                    writeStoredModel(AUTO_MODEL_VALUE);
                    return;
                  }
                  const previous = modelValue;
                  setModelSelection(value);
                  void (async () => {
                    try {
                      setError(null);
                      const result = await sendJson<{ task: TaskSummary }>(
                        `/api/tasks/${taskId}/model`,
                        { model: value },
                      );
                      if (modelChangeRef.current !== changeId) return;
                      // 具体モデルへ明示切替したら Auto 記録と既定値も外し、再表示で Auto に戻さない。
                      clearAutoTaskRecord(taskId);
                      setAutoRecord(null);
                      writeStoredModel(value);
                      setTask((current) => (current ? { ...current, ...result.task } : current));
                      if (isThinkingLevel(result.task.thinkingLevel)) {
                        writeStoredThinkingLevel(result.task.thinkingLevel);
                      }
                      notifyTasksChanged();
                    } catch (err) {
                      if (modelChangeRef.current !== changeId) return;
                      setModelSelection(
                        previous === plainTaskModelValue ? "" : previous,
                      );
                      setError(err instanceof Error ? err.message : "モデルの切替に失敗しました");
                    }
                  })();
                }}
                className="h-8 min-w-0 max-w-[10rem] sm:max-w-[12rem]"
              />
              {modelValue === AUTO_MODEL_VALUE ? (
                <AutoOptimizeSelect
                  value={autoOptimizeMode}
                  disabled={compacting || archived}
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
                  value={thinkingValue}
                  disabled={compacting || archived}
                  className="h-8 shrink-0"
                  onChange={(value) => {
                    void (async () => {
                      try {
                        setError(null);
                        const result = await sendJson<{ task: TaskSummary }>(
                          `/api/tasks/${taskId}/thinking`,
                          { thinkingLevel: value },
                        );
                        setTask((current) => (current ? { ...current, ...result.task } : current));
                        writeStoredThinkingLevel(
                          isThinkingLevel(result.task.thinkingLevel) ? result.task.thinkingLevel : value,
                        );
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "思考レベルの切替に失敗しました");
                      }
                    })();
                  }}
                />
              )}
              {agents.length > 0 && (
                <AgentSelect
                  value={agentSelection}
                  agents={agents}
                  disabled={compacting || agentChanging || archived}
                  onChange={(value) => {
                    if (value === AUTO_AGENT_VALUE) {
                      setAgentSelection(value);
                      writeStoredAgent(value);
                      return;
                    }
                    const previous = agent;
                    const previousSelection = agentSelection;
                    setAgentSelection(value);
                    setAgent(value);
                    writeStoredAgent(value);
                    setAgentChanging(true);
                    void sendJson<{ task: TaskSummary }>(`/api/tasks/${taskId}/agent`, { agent: value })
                      .then(({ task: updatedTask }) => {
                        const nextAgent = updatedTask.agent?.trim() || DEFAULT_AGENT;
                        setAgent(nextAgent);
                        setAgentSelection(nextAgent);
                        setTask((current) => (current ? { ...current, ...updatedTask } : current));
                        setError(null);
                      })
                      .catch((err) => {
                        setAgent(previous);
                        setAgentSelection(previousSelection);
                        writeStoredAgent(previousSelection);
                        setError(err instanceof Error ? err.message : "エージェントの切替に失敗しました");
                      })
                      .finally(() => setAgentChanging(false));
                  }}
                  className="h-8 min-w-0 max-w-[8rem] sm:max-w-40"
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
                disabled={compacting || archived}
                onChange={(mode) => {
                  const previous = permissionMode;
                  setPermissionMode(mode);
                  void (async () => {
                    try {
                      const { task: updated } = await sendJson<{ task: TaskSummary }>(
                        `/api/tasks/${taskId}/permission-mode`,
                        { mode },
                      );
                      setPermissionMode(updated.permissionMode ?? mode);
                      setTask((current) => (current ? { ...current, ...updated } : current));
                      setError(null);
                    } catch (err) {
                      setPermissionMode(previous);
                      setError(err instanceof Error ? err.message : "権限モードの更新に失敗しました");
                    }
                  })();
                }}
                className="h-8 shrink-0"
              />
              <SkillPermissionSelect
                value={skillPermission}
                disabled={compacting || archived}
                onChange={(permission) => {
                  void (async () => {
                    try {
                      const { task: updated } = await sendJson<{ task: TaskSummary }>(
                        `/api/tasks/${taskId}/skill-permission`,
                        { permission },
                      );
                      setSkillPermission(updated.skillPermission ?? permission);
                      setTask((current) => (current ? { ...current, ...updated } : current));
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
                disabled={compacting || archived}
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
                disabled={archived || submitting || working || agentChanging || Boolean(task?.goalLoop && !["completed", "blocked", "stopped"].includes(task.goalLoop.status))}
                onToggle={() => setGoalLoopEnabled((value) => !value)}
              />
                </>
              ),
            },
            {
              id: "delivery",
              label: "送信方式",
              content: (
                <>
              <GhostSelect
                value={deliveryMode}
                disabled={!task || compacting || archived}
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
                className="h-8 max-w-[8rem] shrink-0"
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
              ),
            },
            ...(task?.sessionId
              ? [
                  {
                    id: "next-action",
                    label: "次の指示",
                    content: (
                      <NextAction
                        taskId={taskId}
                        sessionId={task.sessionId}
                        model={selectedModel?.value === AUTO_MODEL_VALUE ? undefined : selectedModel}
                        invalidateKey={`${messages.length}:${messages.at(-1)?.id ?? ""}:${working ? "working" : "idle"}`}
                        disabled={compacting || archived}
                        onApply={(suggestion) => {
                          if (
                            prompt.trim() &&
                            typeof window !== "undefined" &&
                            !window.confirm("現在の入力内容を提案で置き換えますか？")
                          ) {
                            return false;
                          }
                          setPrompt(suggestion);
                          textareaRef.current?.focus();
                          return true;
                        }}
                      />
                    ),
                  },
                ]
              : []),
          ]}
          action={
            working && !prompt.trim() && attachments.length === 0 ? (
              <Button
                variant="danger"
                size="icon"
                aria-label="停止"
                title="停止"
                className={`${COMPOSER_ACTION_BUTTON_CLASS} !bg-danger !text-white hover:!opacity-90`}
                busy={stopRequested}
                disabled={stopRequested}
                onClick={() => void abortWorking()}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="icon"
                type="submit"
                aria-label={working ? (deliveryMode === "queue" ? "キューに追加" : "割り込みを送信") : "送信"}
                title={working ? (deliveryMode === "queue" ? "現在の処理後に送信" : "実行中の処理へ割り込み") : "送信"}
                className={`${COMPOSER_ACTION_BUTTON_CLASS} !bg-accent !text-white hover:!bg-accent/90`}
                busy={submitting}
                disabled={archived || compacting || agentChanging || ((goalLoopEnabled || goalLoopLive) && working) || (!prompt.trim() && attachments.length === 0)}
              >
                {!submitting && <ArrowUp className="h-4 w-4" />}
              </Button>
            )
          }
        />
      </div>
    </div>
  );
});

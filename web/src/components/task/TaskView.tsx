"use client";

import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  GitGraph,
  Loader2,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  Shrink,
  WandSparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  COMPOSER_ACTION_BUTTON_CLASS,
  Composer,
  composerPromptAttachments,
  readComposerFiles,
  useComposerPromptPresetReferences,
  type ComposerAttachment,
  type ComposerReference,
} from "@/components/Composer";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { isImeComposingEvent } from "@/lib/composer-ime";
import { GoalLoopPanel } from "@/components/GoalLoopPanel";
import { DEFAULT_GOAL_LOOP_MAX_TURNS, isGoalLoopSessionOwnedStatus } from "@/lib/goal-loop-settings";
import { DiffPane } from "@/components/task/DiffPane";
import { readSidePanelWidth, SidePanel } from "@/components/task/SidePanel";
import { useBotFor, useIconFor } from "@/components/shell/TaskPanesContext";
import { NextAction } from "@/components/task/NextAction";
import { TaskProgressAsk } from "@/components/task/TaskProgressAsk";
import { GraphPanel } from "@/components/task/GraphPanel";
import { ProjectExplorerButton } from "@/components/task/ProjectExplorerButton";
import { TaskFindPanel } from "@/components/task/TaskFindPanel";
import { useTaskFind } from "@/components/task/use-task-find";
import { useForkDraft } from "@/components/task/use-fork-draft";
import { useComposerDraft } from "@/lib/use-composer-draft";
import { ProjectFilePicker } from "@/components/ProjectFilePicker";
import { SessionLabelBadge } from "@/components/SessionLabelBadge";
import { TodoProgressPanel } from "@/components/task/TodoProgressPanel";
import { SessionResumePanel } from "@/components/task/SessionResumePanel";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { FastModeSelect } from "@/components/FastModeSelect";
import { AgentSelect } from "@/components/AgentSelect";
import { StatusBadge } from "@/components/StatusBadge";
import { MobileMenuButton } from "@/components/shell/MobileMenuHeader";
import { MessageMetaHeader, PartView, ToolCard, WorkingRow } from "@/components/task/PartView";
import { PermissionAdvice } from "@/components/task/PermissionAdvice";
import { QuestionCard } from "@/components/task/QuestionCard";
import {
  QueuedFollowUpsNotice,
  type QueuedFollowUp,
} from "@/components/task/QueuedFollowUpsNotice";
import { Badge, Button, cx, formatDuration } from "@/components/ui";
import { ActivityLog, type ActivityUsage, conversationContentClass, conversationViewportClass, MessageHeader } from "@/components/ConversationLayout";
import {
  AUTO_MODEL_OPTION,
  AUTO_MODEL_VALUE,
  autoModelValue,
  autoVariantToThinkingLevel,
  type AutoDecision,
  type AutoOptimizeMode,
} from "@/lib/auto-model";
import {
  AUTO_MODEL_ENABLED_SETTING_KEY,
  AUTO_OPTIMIZE_SETTING_KEY,
  AUTO_ROUTE_OVERRIDES_SETTING_KEY,
  hasStoredAutoSetting,
  readAutoModelEnabled,
  readAutoOptimizeMode,
  readAutoRouteConfig,
  readAutoSettingsFromServer,
  subscribeAutoSetting,
  writeAutoModelEnabled,
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
import { messageModelLabel, messageModelLabels } from "@/lib/message-model-label";
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
import { formatTokensPerSecond, isSlowTokensPerSecond, summarizeThroughput } from "@/lib/token-throughput";
import { notifyBotSidebarChanged, notifyTasksChanged } from "@/lib/events";
import { taskSidebarNotifyKey } from "@/lib/task-sidebar-notify";
import { markRead } from "@/lib/bot-unread";
import { getJson, sendJson, sendTaskPrompt } from "@/lib/client";
import {
  hasNewUserMessageSince,
  hasReceivedSubmittedPrompt,
  isUnconfirmedPromptDelivery,
  optimisticUserMessage,
  shouldShowWorkingRow,
} from "@/lib/prompt-delivery";
import { readCachedModels, writeCachedModels } from "@/lib/models-cache";
import {
  AUTO_AGENT_VALUE,
  DEFAULT_AGENT,
  hasMultipleAgentChoices,
  readStoredAgent,
  resolveAgentSelection,
  writeStoredAgent,
} from "@/lib/default-agent";
import { messageNavigationTarget } from "@/lib/message-navigation";
import { isStableMessageId } from "@shared/task-search.mjs";
import {
  EMPTY_TASK_MESSAGE_HISTORY,
  isInvalidTaskMessageCursorError,
  mergeNewerTaskMessages,
  pageTaskMessages,
  prependOlderTaskMessages,
  remapTaskMessageCursor,
} from "@/lib/task-history";
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
  shouldBlockSubmitWhileStopRequested,
  shouldClearStopRequestedOnWorkingTransition,
  type ResumableTurn,
} from "@/lib/aborted-resume";
import {
  shouldAutoSendQueuedFollowUp,
  shouldClearQueuedFollowUpOnAbortState,
  shouldClearQueuedFollowUpOnEvent,
  shouldDrainQueuedFollowUp,
  shouldQueueFollowUp,
  shouldRestoreQueuedFollowUpOnFailure,
} from "@/lib/queued-follow-up";
import { hangRetryNoticeCount, isHangRetryUserMessage } from "@/lib/hang-retry";
import { mergeTaskDelta, type TaskDeltaState } from "@/lib/task-delta";
import {
  cancelPendingSseReconnect,
  closeSseSource,
  sseReconnectDelayMs,
  subscribeSseReconnectWake,
} from "@/lib/sse-reconnect";
import {
  applyGoalLoopSummaryToDetail,
  goalLoopActionConflictMessage,
  goalLoopActionSatisfied,
} from "@/lib/goal-loop-detail-sync";

const MODEL_KEY = "leafcodepi.defaultModel";
/** Match BotView: release hydration after this many transport reconnect failures. */
const TASK_SSE_DISCONNECTED_AFTER_ATTEMPTS = 3;
const TASK_SSE_DISCONNECTED_MESSAGE = "イベント接続が切断されています。再接続しています…";
const USER_OWNERSHIP_OPTION = "__user_ownership__";
/** Safety-net poll for the worktree change count; task mutations also refresh it immediately. */
const WORKTREE_STATUS_POLL_MS = 10_000;
// 自動更新の実装は復帰用に保持し、現在の仕様では手動生成だけを有効にする。
const TITLE_AUTO_UPDATE_ENABLED = false;
// Backend prompt forwarding is bounded at 60s (180s for Auto/auto-agent); leave a short reply margin.
const PROMPT_SUBMIT_TIMEOUT_MS = 65_000;
const LONG_PROMPT_SUBMIT_TIMEOUT_MS = 185_000;
const PROMPT_DELIVERY_RECONCILE_TIMEOUT_MS = 10_000;
const PROMPT_DELIVERY_READ_TIMEOUT_MS = 2_000;
/** Longest an accepted prompt echo may wait for the owner's transcript row before it is dropped. */
const OPTIMISTIC_PROMPT_MAX_MS = 60_000;
/** Grace before the soft "イベント接続を再試行しています" banner paints for a transport blip. */
const SSE_RECONNECT_BANNER_DELAY_MS = 2_500;
const PROMPT_DELIVERY_RETRY_INITIAL_DELAY_MS = 250;
const PROMPT_DELIVERY_RETRY_MAX_DELAY_MS = 1_000;

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
import { readTaskTtsEnabled, speakText, stopSpeaking, subscribeTaskTtsEnabled, writeTaskTtsEnabled } from "@/lib/tts-playback";
import {
  decideNotification,
  notificationText,
} from "@/lib/notify";
import { useNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";
import {
  isThinkingLevel,
  resolveThinkingLevel,
  thinkingLevelMetaLabel,
  writeStoredThinkingLevel,
} from "@/lib/thinking-levels";
import type {
  BotDto,
  DiffFilesPayload,
  GoalLoopDto,
  GoalLoopTurn,
  ModelOption,
  PermissionRequestDto,
  QuestionRequestDto,
  SessionResumeDto,
  TaskDetail,
  TaskMessageHistory,
  TaskMessagePage,
  TaskStatus,
  TaskSummary,
  TodoDto,
  ThinkingLevel,
  UiMessage,
  UiPart,
} from "@/lib/types";
import { statusFromChangedFileCount, type WorktreeStatus } from "@/lib/worktree-status";

/** Manual compaction can take longer than the default client request budget. */
const COMPACT_TIMEOUT_MS = 240_000;
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
type TaskDetailWithCompactionSuggestion = TaskDetail & {
  compactionSuggested?: boolean;
};

function sameTaskDetail(a: TaskDetail | null, b: TaskDetail): boolean {
  if (!a) return false;
  return (
    a.status === b.status &&
    a.title === b.title &&
    // Background labels keep updatedAt, so the label itself must be compared.
    a.label === b.label &&
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
    (a as TaskDetailWithCompactionSuggestion).compactionSuggested ===
      (b as TaskDetailWithCompactionSuggestion).compactionSuggested &&
    a.goalLoop === b.goalLoop &&
    a.todos === b.todos &&
    a.sessionResume?.id === b.sessionResume?.id &&
    a.sessionResume?.at === b.sessionResume?.at &&
    a.sessionResume?.message === b.sessionResume?.message &&
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

/** Both panels must leave a readable minimum width for the timeline. */
const TIMELINE_MIN_WIDTH = 480;

function sameGoalLoopTurn(a: GoalLoopTurn, b: GoalLoopTurn): boolean {
  return a.goalId === b.goalId && a.turn === b.turn && a.kind === b.kind;
}

/**
 * 送信者をBotとして描画する user メッセージか。
 * Botが送った依頼（`fromBot`）と、Bot開始セッションのGoal Loop目標だけが該当し、
 * Code画面の入力欄からユーザーが送った本文は該当しない。
 */
function isBotSentUserMessage(message: UiMessage, botId: string | undefined): boolean {
  if (message.role !== "user") return false;
  return Boolean(message.fromBot) || Boolean(botId && message.goalLoopTurn);
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
  const title = `ループ ${turn.turn}`;
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
  /** 本文を作業ログへ畳んだか（畳んでいなければ本文を枠外の吹き出しに出す）。 */
  foldsText: boolean;
};

type TaskMessageBlock =
  | { kind: "message"; message: UiMessage; index: number; showTurnDivider: boolean }
  | {
      kind: "tool-group";
      entries: TaskActivityEntry[];
      startIndex: number;
      showTurnDivider: boolean;
    };

// 派生メッセージは元メッセージごとにキャッシュする。毎レンダリングで作り直すと
// PartView / ToolCard の memo 比較（参照一致）が常に外れ、SSE のたびに全行が再描画される。
const taskActivityEntryCache = new WeakMap<UiMessage, TaskActivityEntry | null>();
const taskTextMessageCache = new WeakMap<UiMessage, UiMessage>();

/** assistant の本文だけをメッセージとして残し、それ以外の表示要素を活動グループへ送る。 */
function taskActivityEntry(message: UiMessage): TaskActivityEntry | null {
  const cached = taskActivityEntryCache.get(message);
  if (cached !== undefined) return cached;
  const entry = buildTaskActivityEntry(message);
  taskActivityEntryCache.set(message, entry);
  return entry;
}

function hasVisibleAssistantText(message: UiMessage): boolean {
  return message.role === "assistant" && message.parts.some(
    (part) => part.type === "text" && Boolean(part.text.trim()),
  );
}

/** 履歴に残る無言assistantは活動グループの境界ではないため表示しない。 */
function isEmptyAssistantMessage(message: UiMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.error &&
    (message.diagnostics?.length ?? 0) === 0 &&
    !hasVisibleAssistantText(message) &&
    message.parts.every((part) => part.type === "text")
  );
}

/**
 * ツール呼び出しに付く前置きと、読む価値のある本文を分ける長さ。実測で前置きは
 * 53〜227字、ターンの回答は437字以上だった。
 * ponytail: 文字数だけのヒューリスティック。誤判定が目立つなら、そのターンの
 * 最後のメッセージかどうかなど構造的な判定へ変える。
 */
const ACTIVITY_PREAMBLE_MAX_CHARS = 320;

function assistantTextLength(message: UiMessage): number {
  let length = 0;
  for (const part of message.parts) {
    if (part.type === "text") length += part.text.trim().length;
  }
  return length;
}

function buildTaskActivityEntry(message: UiMessage): TaskActivityEntry | null {
  if (message.role !== "assistant") return null;
  const hasActivity =
    message.parts.some((part) => part.type !== "text") ||
    Boolean(message.error) ||
    (message.diagnostics?.length ?? 0) > 0;
  if (!hasActivity) return null;
  // ツール呼び出しと同じメッセージの本文は前置き（「次に〜する」）なので、
  // 枠外へ出すとツール1回ごとに作業ログが分断される。一方で thinking だけを
  // 伴う本文はそのターンの回答なので、折りたたみに隠さず吹き出しへ残す。
  const foldsText =
    message.parts.some((part) => part.type === "tool") &&
    assistantTextLength(message) <= ACTIVITY_PREAMBLE_MAX_CHARS;
  const parts = message.parts.filter(
    (part) => part.type !== "text" || (foldsText && Boolean(part.text.trim())),
  );
  return {
    message,
    activityMessage: parts.length === message.parts.length ? message : { ...message, parts },
    showHeader: foldsText || !hasVisibleAssistantText(message),
    foldsText,
  };
}

/** 作業ログへ畳まない本文だけを残した表示用メッセージ。 */
function taskTextMessage(message: UiMessage): UiMessage {
  const cached = taskTextMessageCache.get(message);
  if (cached) return cached;
  const textMessage: UiMessage = {
    ...message,
    parts: message.parts.filter((part) => part.type === "text"),
    error: undefined,
    diagnostics: undefined,
  };
  taskTextMessageCache.set(message, textMessage);
  return textMessage;
}

function taskActivityCount(entry: TaskActivityEntry): number {
  return (
    entry.activityMessage.parts.length +
    (entry.activityMessage.error ? 1 : 0) +
    (entry.activityMessage.diagnostics?.length ?? 0)
  );
}



function taskMessageBlocks(
  messages: UiMessage[],
  ungroupedMessageId?: string,
): TaskMessageBlock[] {
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
    } else if (showTurnDivider) {
      flushGroup();
      groupStartIndex = index;
      groupShowTurnDivider = true;
    }
    groupedEntries.push(entry);
  };

  let pendingTurnBoundary = false;
  messages.forEach((message, index) => {
    // 無言終了したassistantを単独行にすると、ヘッダーだけの行が残り作業ログも分断される。
    // resume判定は表示前のvisibleMessagesを使うので、履歴情報は失わない。
    if (isEmptyAssistantMessage(message)) {
      // Goal Loop の区切りだけは次に表示するブロックへ引き継ぐ。
      if (isGoalLoopTurnBoundary(messages, index)) pendingTurnBoundary = true;
      return;
    }
    const activity = message.id === ungroupedMessageId ? null : taskActivityEntry(message);
    const boundary = pendingTurnBoundary || isGoalLoopTurnBoundary(messages, index);
    pendingTurnBoundary = false;
    if (activity) {
      addActivity(activity, index, boundary);
      if (activity.foldsText || !hasVisibleAssistantText(message)) return;
      // thinking は本文より前に起きているので、作業ログを先に閉じてから本文を出す。
      flushGroup();
      blocks.push({
        kind: "message",
        message: taskTextMessage(message),
        index,
        // 区切りは先に描かれる活動グループ側で出すので、二重に出さない。
        showTurnDivider: false,
      });
      return;
    }
    flushGroup();
    blocks.push({ kind: "message", message, index, showTurnDivider: boundary });
  });
  flushGroup();
  return blocks;
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
        "w-full max-w-bubble self-start rounded-card border px-3 py-2",
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
      className="flex min-w-0 items-center gap-1 text-[10px] text-muted @min-[500px]/task:ml-1 @min-[500px]/task:shrink-0 @min-[500px]/task:gap-1.5 @min-[500px]/task:text-[11px]"
      title={`コンテキスト使用量: ${usedLabel} / ${limitLabel} トークン（${pctLabel}）`}
    >
      <span className="h-1 w-6 shrink-0 overflow-hidden rounded-full bg-surface-2 @min-[500px]/task:h-1.5 @min-[500px]/task:w-10">
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
      <span className="truncate tabular-nums">
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
  // Key the cache lookup by task so the reset effect reuses this parsed
  // snapshot instead of parsing/validating the whole cache a second time.
  const cachedSession = useMemo(() => loadTaskSessionCache(taskId), [taskId]);
  const [task, setTask] = useState<TaskDetail | null>(cachedSession);
  useEffect(() => {
    if (!active || !task?.updatedAt) return;
    const markCurrentRead = () => {
      if (!document.hidden) markRead("task", taskId, Date.parse(task.updatedAt));
    };
    markCurrentRead();
    document.addEventListener("visibilitychange", markCurrentRead);
    return () => document.removeEventListener("visibilitychange", markCurrentRead);
  }, [active, task?.updatedAt, taskId]);
  // Bot起点のタスクはBot画面と同一キーにし、どちらでOFFにしても全体が黙る。
  // ponytail: キー共有だけで連携は済む。別管理に戻すときはこの1行を taskId に戻す。
  const ttsKey = task?.botId ?? taskId;
  const [ttsEnabled, setTtsEnabled] = useState(() => readTaskTtsEnabled(task?.botId ?? taskId));
  const [ttsGlobalEnabled, setTtsGlobalEnabled] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getJson<{ enabled?: boolean }>("/api/settings/tts")
      .then((result) => {
        if (!cancelled) setTtsGlobalEnabled(result.enabled === true);
      })
      .catch(() => {
        // 未取得時は既定の OFF のままボタンを表示しない。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const enabled = readTaskTtsEnabled(ttsKey);
    setTtsEnabled(enabled);
    if (!enabled) stopSpeaking();
  }, [ttsKey]);
  const toggleTts = () => {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    setTtsError(null);
    writeTaskTtsEnabled(ttsKey, next);
    if (!next) stopSpeaking();
  };
  useEffect(() => subscribeTaskTtsEnabled(ttsKey, (enabled) => {
    setTtsEnabled(enabled);
    if (!enabled) stopSpeaking();
  }), [ttsKey]);
  const botFor = useBotFor();
  const iconFor = useIconFor();
  const [supervisorBots, setSupervisorBots] = useState<BotDto[]>([]);
  const [supervisorBusy, setSupervisorBusy] = useState(false);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>(() => cachedSession?.messages ?? []);
  const [messageHistory, setMessageHistory] = useState<TaskMessageHistory>(
    () => cachedSession?.messageHistory ?? EMPTY_TASK_MESSAGE_HISTORY,
  );
  const messageHistoryRef = useRef(messageHistory);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /**
   * Local echo of the prompt just sent, rendered after the transcript until the owner's row lands.
   * Not part of `messages`, so caches, navigation, resume detection and history never see it.
   */
  const [optimisticPrompt, setOptimisticPrompt] = useState<{
    message: UiMessage;
    before: UiMessage[];
    accepted: boolean;
  } | null>(null);
  /** Synchronous double-submit latch (render state lags a same-frame second Enter / click). */
  const submitInFlightRef = useRef(false);
  /** Cancels an in-flight Goal Loop start when the user aborts or switches tasks. */
  const goalLoopStartAbortRef = useRef<AbortController | null>(null);
  /** Bumped on task switch so in-flight Goal Loop control responses cannot land on the next task. */
  const goalLoopActionEpochRef = useRef(0);
  /** Bumped on task switch so a permission/question answer cannot paint its error on the next task. */
  const attentionEpochRef = useRef(0);
  /**
   * A steer ("今すぐ送信" while working) leaves the queue at once but only reaches the transcript at
   * the next tool boundary; without this notice the instruction seems to vanish in between.
   */
  const [pendingSteer, setPendingSteer] = useState<{
    text: string;
    before: UiMessage[];
    accepted: boolean;
  } | null>(null);
  const historyLoadingRef = useRef(false);
  const historyRequestEpochRef = useRef(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyLoadedRef = useRef(false);
  const [models, setModels] = useState<ModelOption[]>(() => readCachedModels() ?? []);
  // キャッシュ hit なら loading を立てず、裏で /api/models を再検証する。
  const [modelsLoading, setModelsLoading] = useState(() => models.length === 0);
  const [modelSelection, setModelSelection] = useState("");
  const modelChangeRef = useRef(0);
  const thinkingChangeRef = useRef(0);
  const thinkingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [autoModelEnabled, setAutoModelEnabled] = useState(() => readAutoModelEnabled());
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
  const [compactionSuggested, setCompactionSuggested] = useState(
    () => Boolean((cachedSession as TaskDetailWithCompactionSuggestion | null)?.compactionSuggested),
  );
  const [isCompacting, setIsCompacting] = useState(Boolean(cachedSession?.isCompacting));
  const [compactingLocal, setCompactingLocal] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const revertEntryRef = useRef<{ messageId: string; message: UiMessage | undefined } | null>(null);
  const { prompt, setPrompt, attachments, setAttachments } = useComposerDraft(`task:${taskId}`);
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
  const [goalLoopMaxTurns, setGoalLoopMaxTurns] = useState(DEFAULT_GOAL_LOOP_MAX_TURNS);
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
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const [queuedAutoSend, setQueuedAutoSend] = useState(false);
  const [failedQueuedId, setFailedQueuedId] = useState<number | null>(null);
  const nextQueueIdRef = useRef(1);
  const queueClearEpochRef = useRef(0);
  const queuedSendRef = useRef<QueuedFollowUp | null>(null);
  const sendingQueuedIdRef = useRef<number | null>(null);
  const submitRef = useRef<(queued?: QueuedFollowUp) => Promise<void>>(async () => undefined);
  const [promptSubmitting, setSubmitting] = useState(false);
  /** Panel control (pause/resume/stop/complete) in flight. */
  const [goalLoopSubmitting, setGoalLoopSubmitting] = useState(false);
  /**
   * Start POST in flight. Kept apart from goalLoopSubmitting: the owner may already run the loop
   * (SSE shows it) while the start reply is pending, and Pause/Stop must stay usable then.
   */
  const [goalLoopStarting, setGoalLoopStarting] = useState(false);
  /** Bumped by every applied panel control so a slower start reply cannot repaint a stale loop. */
  const goalLoopControlSeqRef = useRef(0);
  /**
   * Panel Pause/Stop while a loop turn is working aborts that turn on the owner, but the session
   * only settles a moment later. Without this the WorkingRow kept saying 作業中 (or was hidden
   * behind streaming text) as if the press did nothing.
   */
  const [goalLoopHalting, setGoalLoopHalting] = useState<"pause" | "stop" | null>(null);
  const submitting = promptSubmitting || goalLoopSubmitting || goalLoopStarting;
  const [resumingTurn, setResumingTurn] = useState(false);
  const [resumeTurnError, setResumeTurnError] = useState<string | null>(null);
  const [manualAbortedAssistantId, setManualAbortedAssistantId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  /**
   * The composer Stop POST itself is in flight. Unlike the stopRequested latch (which outlives a
   * successful abort), this only fences racing Goal Loop panel controls for the request's duration
   * — a loop left paused by the abort must stay resumable.
   */
  const [abortInFlight, setAbortInFlight] = useState(false);
  const abortInFlightRef = useRef(false);
  const prevStatusWorkingRef = useRef(false);
  const [hangRetryCount, setHangRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionHydrating, setSessionHydrating] = useState(Boolean(cachedSession));
  const [sseReconnecting, setSseReconnecting] = useState(false);
  const [settledSilentMessageId, setSettledSilentMessageId] = useState<string | null>(null);
  const autoResumeKeyRef = useRef<string | null>(null);
  const [agents, setAgents] = useState<ComposerReference[]>([]);
  const [autoAgentEnabled, setAutoAgentEnabled] = useState(false);
  const [skills, setSkills] = useState<ComposerReference[]>([]);
  const promptPresetReferences = useComposerPromptPresetReferences();
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
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequestDto | null>(null);
  const [questionRequest, setQuestionRequest] = useState<QuestionRequestDto | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const clearedPermissionIdsRef = useRef(new Set<string>());
  const clearedQuestionIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const unsubscribeModelEnabled = subscribeAutoSetting(AUTO_MODEL_ENABLED_SETTING_KEY, () =>
      setAutoModelEnabled(readAutoModelEnabled()),
    );
    const unsubscribeMode = subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, () =>
      setAutoOptimizeMode(readAutoOptimizeMode()),
    );
    const unsubscribeRouteConfig = subscribeAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY, () =>
      setAutoRouteConfig(readAutoRouteConfig()),
    );
    return () => {
      unsubscribeModelEnabled();
      unsubscribeMode();
      unsubscribeRouteConfig();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void readAutoSettingsFromServer().then((snapshot) => {
      if (!active) return;
      if (
        snapshot.modelEnabled !== undefined &&
        !hasStoredAutoSetting(AUTO_MODEL_ENABLED_SETTING_KEY)
      ) {
        writeAutoModelEnabled(snapshot.modelEnabled);
        setAutoModelEnabled(snapshot.modelEnabled);
      }
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
  const nextActionPanelRef = useRef<HTMLDivElement>(null);
  const progressPanelRef = useRef<HTMLDivElement>(null);
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
  const lastScrollHeightRef = useRef(0);
  const previousWorkingRef = useRef(false);
  const titleTaskRef = useRef(taskId);
  const titleCompletionPendingRef = useRef(false);
  const titleUpdatedTurnRef = useRef<string | null>(null);
  const labelTaskRef = useRef(taskId);
  const labelUpdatedTurnRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleMutationRef = useRef(0);
  const labelMutationRef = useRef(0);
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
        messageHistory,
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
  }, [contextUsage, isCompacting, messageHistory, messages, sessionHydrating, task, taskId]);

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
    const page = detail.messageHistory
      ? { messages: detail.messages, messageHistory: detail.messageHistory }
      : pageTaskMessages(detail.messages);
    const nextDetail = {
      ...detail,
      messages: page.messages,
      messageHistory: page.messageHistory,
    };
    setTask(nextDetail);
    setMessages((prev) =>
      detail.messageHistory
        ? mergeNewerTaskMessages(prev, page.messages)
        : stabilizeUiMessages([], page.messages),
    );
    historyRequestEpochRef.current += 1;
    historyLoadedRef.current = false;
    historyLoadingRef.current = false;
    messageHistoryRef.current = page.messageHistory;
    setMessageHistory(page.messageHistory);
    setHistoryLoading(false);
    setHistoryError(null);
    setContextUsage(detail.contextUsage);
    setCompactionSuggested(Boolean((detail as TaskDetailWithCompactionSuggestion).compactionSuggested));
    setIsCompacting(Boolean(detail.isCompacting));
    setSessionHydrating(false);
    const nextPermission = detail.permissionRequest ?? null;
    setPermissionRequest(
      nextPermission && clearedPermissionIdsRef.current.has(nextPermission.id) ? null : nextPermission,
    );
    const nextQuestion = detail.questionRequest ?? null;
    setQuestionRequest(
      nextQuestion && clearedQuestionIdsRef.current.has(nextQuestion.id) ? null : nextQuestion,
    );
    if ("manualAbortedAssistantId" in detail) {
      setManualAbortedAssistantId(detail.manualAbortedAssistantId ?? null);
    }
    if (typeof detail.hangRetryCount === "number") {
      setHangRetryCount(detail.hangRetryCount);
    }
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
    // 裏ペインは描画されないので、状態リセットも接続も行わない。前面に戻ると
    // active が変わりこの effect が再実行される。
    if (!active) return;
    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let disconnectedShown = false;
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
    setQuestionRequest(null);
    setPermissionBusy(false);
    // Do not evaluate cached messages as authoritative until the SSE ready
    // snapshot replaces them with the server session state.
    setSessionHydrating(true);
    setSseReconnecting(false);
    // キャッシュ済みモデルがあれば loading を立てず、裏で再検証する。
    if ((readCachedModels()?.length ?? 0) === 0) setModelsLoading(true);

    const connect = () => {
      // 分割タブの裏ペインでは接続しない。active が deps にあるので、
      // 前面に戻るとこの effect が再実行されて connect される。
      if (closed || !active) return;
      retryTimer = cancelPendingSseReconnect(retryTimer);
      source = closeSseSource(source);
      // 一部の端末・中継が no-cache の SSE URL を再利用し、reload 後に
      // 古いストリームを返すことがあるため、接続ごとに URL を変える。
      // 安定したアイドル履歴は、キャッシュの revision が一致すれば ready
      // で再送しない。working/compacting のキャッシュは提示しない。
      // delta=1: Backend-owned streams send only changed rows (messagesDelta) after the first page.
      const eventParams = new URLSearchParams({
        epoch: String(Date.now()),
        delta: "1",
        streamDeltas: document.hidden ? "0" : "1",
        streamMessages: document.hidden ? "0" : "1",
      });
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
        if (findResumableTurn(cachedSession.messages)?.reason === "silent") {
          // Resume decisions require transcript truth, not only task revision.
          eventParams.set("cachedSilentResumeCandidate", "1");
        }
      }
      const nextSource = new EventSource(`/api/tasks/${taskId}/events?${eventParams.toString()}`);
      source = nextSource;
      const isCurrentSource = () => !closed && source === nextSource;
      nextSource.addEventListener("snapshot", (event) => {
        if (!isCurrentSource()) return;
        const rawData = (event as MessageEvent).data as string;
        if (TASK_PERF_ENABLED && perf) {
          perf.snapshotCount += 1;
          perf.snapshotChars += typeof rawData === "string" ? rawData.length : 0;
        }
        if (retryCount > 0) setError(null);
        setSseReconnecting(false);
        retryCount = 0;
        disconnectedShown = false;
        setError((current) => (current === TASK_SSE_DISCONNECTED_MESSAGE ? null : current));
        let payload: {
          task?: TaskSummary;
          /** The summary was sent earlier on this SSE connection; reuse the current client value. */
          taskReused?: boolean;
          messages?: UiMessage[];
          isStreaming?: boolean;
          isCompacting?: boolean;
          contextUsage?: ContextUsageDto;
          goalLoop?: GoalLoopDto | null;
          todos?: TodoDto[];
          sessionResume?: SessionResumeDto | null;
          error?: string;
          manualAbortedAssistantId?: string | null;
          hangRetryCount?: number;
          revertLeafId?: string | null;
          permissionRequest?: PermissionRequestDto | null;
          questionRequest?: QuestionRequestDto | null;
          eventType?: string;
          messagesReused?: boolean;
          /** `messages` holds only changed/appended rows; merge, never replace. */
          messagesDelta?: boolean;
          messageHistory?: TaskMessageHistory;
          historyReset?: boolean;
          compactionSuggested?: boolean;
        };
        try {
          payload = JSON.parse(rawData) as typeof payload;
        } catch {
          setError("イベントデータの解析に失敗しました");
          return;
        }
        if (document.hidden && payload.eventType !== "agent_settled") {
          payload.messages = undefined;
          payload.messageHistory = undefined;
          payload.messagesDelta = undefined;
          payload.historyReset = false;
        }
        const snapshotTask = payload.task;
        if (snapshotTask && payload.eventType === "provider_fallback") {
          // The owner moved the route. Do not retain old model/effort options or
          // let an older model request overwrite the fallback snapshot.
          modelChangeRef.current += 1;
          setModelSelection((current) => current === AUTO_MODEL_VALUE ? current : "");
        }
        const snapshotTaskWithSuggestion = snapshotTask as
          | (TaskSummary & { compactionSuggested?: boolean })
          | undefined;
        const suggestedFromSnapshot =
          payload.compactionSuggested ?? snapshotTaskWithSuggestion?.compactionSuggested;
        const isBootstrap =
          payload.eventType === "bootstrap" || payload.eventType === "cache_ready";
        const resetHistory =
          payload.historyReset === true ||
          payload.eventType === "revert" ||
          payload.eventType === "unrevert" ||
          payload.eventType === "conversation_reset";
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
        if (isBootstrap) {
          setSessionHydrating(true);
          setCompactionSuggested(false);
          if (
            payload.messagesReused &&
            cachedSession?.messageHistory?.hasMore &&
            cachedSession.messageHistory.nextCursor
          ) {
            historyLoadedRef.current = true;
          }
        }
        startTransition(() => {
          if (resetHistory) {
            historyRequestEpochRef.current += 1;
            historyLoadedRef.current = false;
            historyLoadingRef.current = false;
            messageHistoryRef.current = EMPTY_TASK_MESSAGE_HISTORY;
            setMessageHistory(EMPTY_TASK_MESSAGE_HISTORY);
            setHistoryLoading(false);
            setHistoryError(null);
          }
          if (!isBootstrap) setSessionHydrating(false);
          // `agent_settled` is the SDK's terminal event: only this snapshot
          // may prove that a turn truly ended without output.
          if (payload.eventType === "agent_settled") {
            const settled = findResumableTurn(payload.messages ?? [], {
              manualAbortedAssistantId: payload.manualAbortedAssistantId,
            });
            setSettledSilentMessageId(
              settled?.reason === "silent" ? settled.messageId : null,
            );
          }
          if (snapshotTask || payload.taskReused) {
            if (snapshotTask) {
              const nextAgent = snapshotTask.agent?.trim() || DEFAULT_AGENT;
              setAgent(nextAgent);
              setAgentSelection((current) =>
                current === AUTO_AGENT_VALUE ? current : nextAgent,
              );
            }
            setTask((current) => {
              const summary = snapshotTask ?? current;
              if (!summary) return current;
              const base: TaskDetail = current ?? {
                ...summary,
                messages: [],
                isStreaming: payload.isStreaming ?? summary.status === "working",
                isCompacting: Boolean(payload.isCompacting),
              };
              const keepExistingMessages = shouldKeepCachedBootstrapMessages({
                currentTaskId: base.id,
                snapshotTaskId: summary.id,
                isBootstrap,
                snapshotMessages: payload.messages,
                currentMessageCount: base.messages.length,
              });
              const next: TaskDetail = {
                ...base,
                ...summary,
                messages: keepExistingMessages || payload.messagesDelta
                  ? base.messages
                  : payload.messages ?? base.messages ?? [],
                messageHistory: payload.messageHistory ?? base.messageHistory,
                isStreaming: payload.isStreaming ?? base.isStreaming,
                isCompacting: payload.isCompacting ?? base.isCompacting,
                contextUsage: payload.contextUsage ?? base.contextUsage,
                goalLoop: "goalLoop" in payload ? payload.goalLoop : base.goalLoop,
                todos: payload.todos ?? base.todos,
                sessionResume: "sessionResume" in payload ? payload.sessionResume : base.sessionResume,
              };
              // 表示に影響しないスナップショット（tool実行中のメッセージ進捗等）は
              // 参照を維持し、TaskView 全体の再レンダーを防ぐ。
              return sameTaskDetail(current, next) ? current : next;
            });
          }
          if (resetHistory && !payload.messagesDelta) {
            setMessages(stabilizeUiMessages([], payload.messages ?? []));
          } else if (
            payload.messages &&
            (!isBootstrap || payload.messages.length > 0) &&
            !(payload.messagesDelta && payload.messages.length === 0)
          ) {
            if (!payload.messageHistory || historyLoadedRef.current) {
              const remapped = remapTaskMessageCursor(
                messageHistoryRef.current,
                messagesRef.current,
                payload.messages,
              );
              if (remapped !== messageHistoryRef.current) {
                messageHistoryRef.current = remapped;
                setMessageHistory(remapped);
              }
            }
            setMessages((prev) => mergeNewerTaskMessages(prev, payload.messages!));
          }
          if (payload.messageHistory && (!historyLoadedRef.current || resetHistory)) {
            messageHistoryRef.current = payload.messageHistory;
            setMessageHistory(payload.messageHistory);
          }
          if ("contextUsage" in payload) {
            setContextUsage((current) =>
              current === payload.contextUsage ? current : payload.contextUsage,
            );
          }
          if ("isCompacting" in payload) setIsCompacting(Boolean(payload.isCompacting));
          if (
            payload.compactionSuggested !== undefined ||
            snapshotTaskWithSuggestion?.compactionSuggested !== undefined
          ) {
            setCompactionSuggested(Boolean(suggestedFromSnapshot));
          }
          if ("manualAbortedAssistantId" in payload) {
            setManualAbortedAssistantId(payload.manualAbortedAssistantId ?? null);
          }
          if (
            shouldClearQueuedFollowUpOnEvent(payload.eventType) ||
            ("manualAbortedAssistantId" in payload &&
              shouldClearQueuedFollowUpOnAbortState(
                payload.manualAbortedAssistantId,
                snapshotTask?.status === "working" || payload.isStreaming === true,
              ))
          ) {
            queueClearEpochRef.current += 1;
            setQueuedFollowUps([]);
            queuedSendRef.current = null;
            setQueuedAutoSend(false);
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
            setPermissionRequest((current) => {
              const next = payload.permissionRequest ?? null;
              if (next && clearedPermissionIdsRef.current.has(next.id)) return null;
              return samePermissionRequest(current, next) ? current : next;
            });
          }
          if ("questionRequest" in payload) {
            setQuestionRequest((current) => {
              const next = payload.questionRequest ?? null;
              if (next && clearedQuestionIdsRef.current.has(next.id)) return null;
              return sameQuestionRequest(current, next) ? current : next;
            });
          }
        });
        if (payload.error) setError(payload.error);
        notifySidebarIfNeeded(snapshotTask);
        const status = snapshotTask?.status;
        if (status) onStatusRef.current?.(taskId, status);
      });
      nextSource.addEventListener("delta", (event) => {
        if (!isCurrentSource() || document.hidden) return;
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
            "contextUsage" in payload ||
            "compactionSuggested" in payload
          ) {
            setTask((current) => {
              const next = mergeTaskDelta(current, payload);
              if (!current || !next) return next;
              return sameTaskDetail(current, next) ? current : next;
            });
          }
          if (payload.message) {
            if (historyLoadedRef.current) {
              const remapped = remapTaskMessageCursor(
                messageHistoryRef.current,
                messagesRef.current,
                [payload.message],
              );
              if (remapped !== messageHistoryRef.current) {
                messageHistoryRef.current = remapped;
                setMessageHistory(remapped);
              }
            }
            setMessages((prev) => upsertUiMessage(prev, payload.message!));
          }
          if ("contextUsage" in payload) {
            setContextUsage((current) =>
              current === payload.contextUsage ? current : payload.contextUsage,
            );
          }
          if ("isCompacting" in payload) setIsCompacting(Boolean(payload.isCompacting));
          if ("compactionSuggested" in payload) {
            setCompactionSuggested(Boolean(payload.compactionSuggested));
          }
        });
        notifySidebarIfNeeded(payload.task);
        if (payload.task?.status) onStatusRef.current?.(taskId, payload.task.status);
      });
      nextSource.addEventListener("error", (event) => {
        if (!isCurrentSource()) return;
        if (event instanceof MessageEvent && typeof event.data === "string") {
          closed = true;
          setSseReconnecting(false);
          // ready 未到達の fatal でも hydration を解除し、キュー drain / resume を永久ブロックしない。
          setSessionHydrating(false);
          source = closeSseSource(nextSource);
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
        // Keep the disconnect alert once shown; clearing it every retry flashes the UI.
        setError((current) => (current === TASK_SSE_DISCONNECTED_MESSAGE ? current : null));
        // Auto-reconnect: close the broken stream and retry with backoff.
        source = closeSseSource(nextSource);
        retryTimer = cancelPendingSseReconnect(retryTimer);
        retryCount += 1;
        // cache_ready / bootstrap keep hydrating=true until ready. If the Backend
        // never answers, release the gate so drain / resume / composer are not
        // blocked forever behind "セッションを準備しています".
        if (retryCount >= TASK_SSE_DISCONNECTED_AFTER_ATTEMPTS && !disconnectedShown) {
          disconnectedShown = true;
          setSessionHydrating(false);
          // Parity with BotView: soft reconnect banner alone looks like a
          // brief blip; after several failures surface a persistent alert
          // while backoff reconnect continues in the background.
          setError(TASK_SSE_DISCONNECTED_MESSAGE);
        }
        const delay = sseReconnectDelayMs(retryCount);
        retryTimer = setTimeout(connect, delay);
      });
    };

    const onVisibilityChange = () => {
      // Reconnect with streamDeltas=0 while hidden and restore the fast path when visible.
      connect();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    // The SSE endpoint sends the initial timeline page; avoid a duplicate task-detail request.
    connect();
    // Skip the rest of a backoff wait when the network / tab comes back.
    const stopReconnectWake = subscribeSseReconnectWake(() => {
      if (closed || retryTimer === null) return;
      retryTimer = cancelPendingSseReconnect(retryTimer);
      connect();
    });

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
    void getJson<{
      agents: { name: string; description?: string; enabled: boolean; model?: string; tools?: string[] }[];
      autoEnabled?: boolean;
    }>("/api/agents").then((result) => {
      if (!closed) {
        const nextAutoAgentEnabled = result.autoEnabled === true;
        setAutoAgentEnabled(nextAutoAgentEnabled);
        const enabledAgents = result.agents
          .filter((a) => a.enabled)
          .map(({ name, description, tools }) => ({ name, description, tools }));
        const enabledAgentNames = enabledAgents.map(({ name }) => name);
        setAgents(enabledAgents);
        setAgent((current) => resolveAgentSelection(current, enabledAgentNames, nextAutoAgentEnabled));
        setAgentSelection((current) => resolveAgentSelection(current, enabledAgentNames, nextAutoAgentEnabled));
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
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopReconnectWake();
      retryTimer = cancelPendingSseReconnect(retryTimer);
      source = closeSseSource(source);
    };
  }, [active, cachedSession, taskId, applyDetail, notifySidebarIfNeeded]);

  /** Loads the next older page. Resolves to that page's messages, or null when nothing was loaded. */
  const loadOlderMessages = useCallback(async (): Promise<UiMessage[] | null> => {
    if (historyLoadingRef.current) return null;
    const history = messageHistoryRef.current;
    if (!history.hasMore || !history.nextCursor) return null;
    const requestEpoch = historyRequestEpochRef.current;
    const viewport = scrollRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await getJson<TaskMessagePage>(
        `/api/tasks/${encodeURIComponent(taskId)}/messages`,
        { before: history.nextCursor },
      );
      if (requestEpoch !== historyRequestEpochRef.current) return null;
      setMessages((current) => prependOlderTaskMessages(current, page.messages));
      historyLoadedRef.current = true;
      messageHistoryRef.current = page.messageHistory;
      setMessageHistory(page.messageHistory);
      window.requestAnimationFrame(() => {
        const currentViewport = scrollRef.current;
        if (!currentViewport || currentViewport !== viewport) return;
        currentViewport.scrollTop = previousTop + currentViewport.scrollHeight - previousHeight;
        lastScrollTopRef.current = currentViewport.scrollTop;
      });
      return page.messages;
    } catch (error) {
      if (requestEpoch === historyRequestEpochRef.current && isInvalidTaskMessageCursorError(error)) {
        try {
          const latest = await getJson<TaskMessagePage>(
            `/api/tasks/${encodeURIComponent(taskId)}/messages`,
          );
          if (requestEpoch !== historyRequestEpochRef.current) return null;
          historyLoadedRef.current = false;
          messageHistoryRef.current = latest.messageHistory;
          setMessageHistory(latest.messageHistory);
          setMessages(() => stabilizeUiMessages([], latest.messages));
          return null;
        } catch (refreshError) {
          error = refreshError;
        }
      }
      if (requestEpoch === historyRequestEpochRef.current) {
        setHistoryError(error instanceof Error ? error.message : "過去の履歴を読み込めませんでした");
      }
      return null;
    } finally {
      if (requestEpoch === historyRequestEpochRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }, [taskId]);
  const scrollToBottom = useCallback((el: HTMLElement) => {
    const top = clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight);
    el.scrollTo({ top, behavior: "auto" });
    lastScrollTopRef.current = top;
    lastScrollHeightRef.current = el.scrollHeight;
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
    const previousHeight = lastScrollHeightRef.current;
    const layoutChanged = el.scrollHeight !== previousHeight;
    const heightDecreased = el.scrollHeight < previousHeight;
    lastScrollHeightRef.current = el.scrollHeight;
    stickRef.current = nextStickState(stickRef.current, el.scrollTop, prevTop, atBottom, undefined, layoutChanged, heightDecreased);
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
    const nextTop = clampScrollTop(targetTop, el.clientHeight, el.scrollHeight);
    stickRef.current = false;
    el.scrollTo({ top: nextTop, behavior: "smooth" });
    lastScrollTopRef.current = nextTop;
  }, []);

  // 最新位置（タイムライン最下部）へ戻り、追従モードを復帰する。
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight);
    stickRef.current = true;
    el.scrollTo({ top, behavior: "smooth" });
  }, []);

  // セッション内検索とメッセージのブックマーク。状態とDOM連携は use-task-find に閉じる。
  const find = useTaskFind({
    taskId,
    active,
    rootRef: taskViewRef,
    scrollRef,
    contentRef,
    stickRef,
    messagesRef,
    historyRef: messageHistoryRef,
    historyLoadingRef,
    loadOlder: loadOlderMessages,
    onError: setError,
  });

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
    const cached = cachedSession;
    const cachedHistory = cached?.messageHistory ?? EMPTY_TASK_MESSAGE_HISTORY;
    setTask(cached);
    setMessages(cached?.messages ?? []);
    setOptimisticPrompt(null);
    setPendingSteer(null);
    messageHistoryRef.current = cachedHistory;
    setMessageHistory(cachedHistory);
    historyLoadedRef.current = false;
    historyLoadingRef.current = false;
    historyRequestEpochRef.current += 1;
    setHistoryLoading(false);
    setHistoryError(null);
    setContextUsage(cached?.contextUsage);
    setCompactionSuggested(Boolean((cached as TaskDetailWithCompactionSuggestion | null)?.compactionSuggested));
    setIsCompacting(Boolean(cached?.isCompacting));
    setCompactingLocal(false);
    setWorktreeStatus(null);
    const nextAutoRecord = readAutoTaskRecord(taskId);
    // Composer 既定の Auto はタスクへ持ち込まない。Auto 表示は当該タスクの Auto 記録があるときだけ。
    setModelSelection(nextAutoRecord ? AUTO_MODEL_VALUE : "");
    setAutoRecord(nextAutoRecord);
    setAutoRetryNotice(null);
    setAutoRetrying(false);
    autoRetryStatusRef.current = cached?.status;
    setGoalLoopEnabled(false);
    setGoalLoopAcceptance("");
    setGoalLoopMaxTurns(DEFAULT_GOAL_LOOP_MAX_TURNS);
    setGoalLoopCooldownSeconds(0);
    setGoalLoopForceFullRun(false);
    setSessionHydrating(true);
    setSettledSilentMessageId(null);
    autoResumeKeyRef.current = null;
    setRevertConfirmOpen(false);
    setRevertBusy(false);
    revertEntryRef.current = null;
    queueClearEpochRef.current += 1;
    setQueuedFollowUps([]);
    queuedSendRef.current = null;
    setQueuedAutoSend(false);
    setFailedQueuedId(null);
    setSubmitting(false);
    goalLoopStartAbortRef.current?.abort();
    goalLoopStartAbortRef.current = null;
    goalLoopActionEpochRef.current += 1;
    attentionEpochRef.current += 1;
    setGoalLoopSubmitting(false);
    setGoalLoopStarting(false);
    setGoalLoopHalting(null);
    setResumingTurn(false);
    setResumeTurnError(null);
    setManualAbortedAssistantId(null);
    stopRequestedRef.current = false;
    setStopRequested(false);
    abortInFlightRef.current = false;
    setAbortInFlight(false);
    prevStatusWorkingRef.current = false;
    setHangRetryCount(0);
    setError(null);
    setPermissionRequest(null);
    setQuestionRequest(null);
    setPermissionBusy(false);
    clearedPermissionIdsRef.current.clear();
    clearedQuestionIdsRef.current.clear();
    const nextAgent = cached?.agent?.trim() || DEFAULT_AGENT;
    setAgent(nextAgent);
    // タスク切替時は当該タスクの agent を表示。Composer 既定 Auto や前タスクの Auto は引き継がない。
    setAgentSelection(nextAgent);
    messageElsRef.current.clear();
    navigationMessageIdsRef.current = [];
    stickRef.current = true;
    lastScrollTopRef.current = 0;
    // Pending model/effort replies no longer own the pane after teardown.
    return () => {
      modelChangeRef.current += 1;
      thinkingQueueRef.current = Promise.resolve();
    };
  }, [cachedSession, taskId]);

  useForkDraft(taskId, setPrompt, setAttachments);

  useLayoutEffect(() => {
    scheduleScrollToBottom();
  }, [messages, task?.isStreaming, isCompacting, optimisticPrompt, scheduleScrollToBottom]);

  // Drop the echo in the same commit that renders the owner's row, so both never show together.
  const optimisticVisible = Boolean(
    optimisticPrompt &&
      !hasNewUserMessageSince(optimisticPrompt.before, messages) &&
      !(optimisticPrompt.accepted && task?.status === "error"),
  );
  useEffect(() => {
    if (!optimisticPrompt) return;
    if (!optimisticVisible) {
      setOptimisticPrompt(null);
      return;
    }
    // Safety net: an accepted prompt that never reaches the transcript must not linger forever.
    const timer = window.setTimeout(() => {
      setOptimisticPrompt((current) => (current === optimisticPrompt ? null : current));
    }, OPTIMISTIC_PROMPT_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [optimisticPrompt, optimisticVisible]);

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
    if (!active) return;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    lastScrollTopRef.current = scroller.scrollTop;
    lastScrollHeightRef.current = scroller.scrollHeight;
    const pinned = () => {
      if (document.visibilityState !== "visible" || !stickRef.current) return;
      if (isNearBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)) return;
      scheduleScrollToBottom();
    };
    let observer: ResizeObserver | undefined;
    let interval: number | undefined;
    const stop = () => {
      observer?.disconnect();
      observer = undefined;
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
    };
    const start = () => {
      if (document.visibilityState !== "visible") return;
      if (typeof ResizeObserver !== "undefined") {
        if (observer) return;
        observer = new ResizeObserver(pinned);
        observer.observe(content);
        pinned();
      } else if (interval === undefined) {
        interval = window.setInterval(pinned, 200);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (typeof ResizeObserver === "undefined") pinned();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [active, scheduleScrollToBottom, taskId]);

  function addFiles(files: FileList) {
    if (!canAttachComposerImages({ goalLoopEnabled, compacting: isCompacting, archived: task?.status === "archived" })) return;
    readComposerFiles(files, (attachment) => {
      setAttachments((current) => [...current, attachment]);
    });
  }

  const compacting = isCompacting || compactingLocal;
  const archived = task?.status === "archived";
  const statusWorking = task?.status === "working";
  const working = Boolean(statusWorking || task?.isStreaming);
  const isReverted = Boolean(task?.revertLeafId);

  // One transport blip (proxy idle recycle, Backend restart) reconnects within ~1s; painting the
  // banner on the first error made every blip flash. Gates still use sseReconnecting at once.
  const [sseReconnectBannerVisible, setSseReconnectBannerVisible] = useState(false);
  useEffect(() => {
    if (!sseReconnecting) {
      setSseReconnectBannerVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setSseReconnectBannerVisible(true), SSE_RECONNECT_BANNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [sseReconnecting]);

  // The steer notice yields to the real row, or to an idle task once the owner accepted it.
  const pendingSteerVisible = Boolean(
    pendingSteer &&
      !hasNewUserMessageSince(pendingSteer.before, messages) &&
      !(pendingSteer.accepted && !working),
  );
  useEffect(() => {
    if (!pendingSteer) return;
    if (!pendingSteerVisible) {
      setPendingSteer(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingSteer((current) => (current === pendingSteer ? null : current));
    }, OPTIMISTIC_PROMPT_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [pendingSteer, pendingSteerVisible]);

  const taskKind = task?.kind;
  const taskSupervisorBotId = task?.supervisorBotId;
  useEffect(() => {
    if (taskKind === "bot" || (!working && !taskSupervisorBotId)) return;
    let cancelled = false;
    getJson<{ bots?: BotDto[] }>("/api/bots")
      .then((result) => {
        if (!cancelled) setSupervisorBots(result.bots ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskKind, taskSupervisorBotId, working]);

  const setSupervisor = useCallback(async (botId: string | null) => {
    if (supervisorBusy) return;
    setSupervisorBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskSummary }>(
        `/api/tasks/${encodeURIComponent(taskId)}/supervisor`,
        { botId },
        "POST",
      );
      setTask((current) => (current ? { ...current, ...result.task } : current));
      notifyTasksChanged();
      notifyBotSidebarChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : botId ? "Botへの引き継ぎに失敗しました" : "Bot委任の解除に失敗しました");
    } finally {
      setSupervisorBusy(false);
    }
  }, [supervisorBusy, taskId]);

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

  // The halting label lives only until the aborted loop turn actually settles.
  useEffect(() => {
    if (!working) setGoalLoopHalting(null);
  }, [working]);

  // PartView は memo 化されており onRevert の参照比較でスキップ判定する。
  // 判定対象は ref から読むことで、status 遷移時も callback を再生成せず、
  // 履歴全体の行を再レンダーしない。
  const archivedForRevertRef = useRef(archived);
  const workingForRevertRef = useRef(working);
  archivedForRevertRef.current = archived;
  workingForRevertRef.current = working;
  const requestRevert = useCallback((target: UiMessage) => {
    if (archivedForRevertRef.current) {
      setError("アーカイブ済みのタスクは巻き戻せません");
      return;
    }
    if (workingForRevertRef.current) {
      setError("実行中は巻き戻せません。停止してからお試しください");
      return;
    }
    revertEntryRef.current = { messageId: target.id, message: target };
    setRevertConfirmOpen(true);
  }, []);
  // 実行中・一時停止中・要対応中は、パネルから操作できるよう表示する。
  // completed / stopped はチャット側に結果が残るため閉じる（Sidebar の LIVE 判定と整合）。
  const goalLoopVisible = isGoalLoopSessionOwnedStatus(task?.goalLoop?.status);
  const hideDefaultAgentInMeta =
    !autoAgentEnabled && agents.length === 1 && agents[0]?.name === DEFAULT_AGENT;
  const queuedSendNowDisabled =
    submitting || queuedAutoSend || resumingTurn || compacting || agentChanging ||
    archived || revertBusy || revertConfirmOpen || sessionHydrating ||
    sseReconnecting || stopRequested || goalLoopEnabled || (goalLoopVisible && !working);

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
    }, WORKTREE_STATUS_POLL_MS);
    return () => {
      closed = true;
      window.removeEventListener("webui:tasks-changed", onTasksChanged);
      window.clearInterval(timer);
    };
  }, [active, task?.directory, task?.status, taskId, working]);

  useEffect(() => {
    if (labelTaskRef.current !== taskId) {
      labelTaskRef.current = taskId;
      labelUpdatedTurnRef.current = null;
      labelMutationRef.current += 1;
    }
    if (working || !task?.sessionId || task.label || !hasCompletedTitleTurn(messages)) return;
    const userMessages = messages.filter(
      (message) => message.role === "user" && !isHangRetryUserMessage(message),
    );
    const firstUserMessage = userMessages[0];
    if (
      userMessages.length !== 1 ||
      !firstUserMessage ||
      labelUpdatedTurnRef.current === firstUserMessage.id
    ) return;
    labelUpdatedTurnRef.current = firstUserMessage.id;
    const mutation = ++labelMutationRef.current;
    void sendJson<{ label?: string }>(`/api/tasks/${taskId}/title`, { labelOnly: true })
      .then((result) => {
        if (mutation !== labelMutationRef.current || !result.label) return;
        setTask((current) => current && !current.label ? { ...current, label: result.label } : current);
        notifyTasksChanged();
      })
      .catch(() => undefined);
  }, [messages, task?.label, task?.sessionId, taskId, working]);

  useEffect(() => {
    if (!TITLE_AUTO_UPDATE_ENABLED) return;
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
    void sendJson<{ title: string; label?: string; task: TaskSummary }>(`/api/tasks/${taskId}/title`, {}).then((result) => {
      if (mutation !== titleMutationRef.current) return;
      setTask((current) =>
        current && resolveTitleAutoUpdateEnabled(current.titleAutoUpdate, titleAutoUpdateDefault)
          ? { ...current, title: result.title, ...(result.label ? { label: result.label } : {}) }
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

  async function refreshTitle() {
    if (!task || archived || titleBusy) return;
    const mutation = ++titleMutationRef.current;
    setTitleBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ title: string; label?: string; task: TaskSummary }>(
        `/api/tasks/${taskId}/title`,
        {},
      );
      if (mutation !== titleMutationRef.current) return;
      setTask((current) =>
        current
          ? { ...current, title: result.title, ...(result.label ? { label: result.label } : {}) }
          : current,
      );
      notifyTasksChanged();
    } catch (err) {
      if (mutation === titleMutationRef.current) {
        setError(err instanceof Error ? err.message : "タイトルの生成に失敗しました");
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
      const result = await sendJson<{
        task: TaskDetail;
        text: string;
        images: ComposerAttachment[];
        files?: ComposerAttachment[];
      }>(
        `/api/tasks/${taskId}/revert`,
        { entryId: target.messageId },
      );
      setPrompt(result.text);
      setAttachments((current) => [
        ...current,
        ...[...result.images, ...(result.files ?? [])].filter(
          (file) => !current.some((item) => item.uri === file.uri),
        ),
      ]);
      clearedPermissionIdsRef.current.clear();
      clearedQuestionIdsRef.current.clear();
      setPermissionRequest(null);
      setQuestionRequest(null);
      setPermissionBusy(false);
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
    if (revertBusy || working || archived) return;
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

  async function submit(queued?: QueuedFollowUp, sendNow = false) {
    const sentQueueEpoch = queueClearEpochRef.current;
    const submittedPrompt = queued ? queued.text : prompt;
    const submittedAttachments = queued ? queued.attachments : attachments;
    const restoreQueuedFollowUp = () => {
      if (
        !queued ||
        !shouldRestoreQueuedFollowUpOnFailure(sentQueueEpoch, queueClearEpochRef.current)
      ) return false;
      setFailedQueuedId(queued.id);
      setQueuedFollowUps((current) =>
        current.some((item) => item.id === queued.id) ? current : [queued, ...current],
      );
      return true;
    };
    if (
      (!submittedPrompt.trim() && submittedAttachments.length === 0) ||
      submitting ||
      // `submitting` is render state: a double Ctrl+Enter / Enter+click in one frame still sees
      // false, so a synchronous latch keeps the same draft from being POSTed twice.
      submitInFlightRef.current ||
      resumingTurn ||
      compacting ||
      agentChanging ||
      archived ||
      revertBusy ||
      revertConfirmOpen ||
      shouldBlockSubmitWhileStopRequested(stopRequestedRef.current, working)
    ) {
      // The queue drain removes this item before submit; preserve it if a same-frame submit lock
      // or another guard wins the race before the request starts.
      if (restoreQueuedFollowUp()) {
        setError("キュー送信を開始できませんでした。キューから再送してください");
      }
      return;
    }
    let draftCleared = false;
    /** Control sequence at Goal Loop start; a panel Pause/Stop meanwhile supersedes the start. */
    let goalStartControlSeq: number | null = null;
    if (
      !queued &&
      shouldQueueFollowUp({ working, goalLoopEnabled })
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
    if (working && goalLoopEnabled) {
      setError("実行中は Goal loop を開始できません");
      return;
    }
    // Images alone are not a goal: the start API requires non-empty goal text.
    if (goalLoopEnabled && !submittedPrompt.trim()) {
      setError("Goal Loop の開始には目標テキストが必要です");
      return;
    }
    // Idle submit after Stop may clear the latch (intentional new run). Do not
    // clear while working — that path is blocked above.
    stopRequestedRef.current = false;
    setStopRequested(false);
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    const beforeSubmitMessages = messagesRef.current.map((message) => ({ ...message }));
    try {
      const { images, files } = composerPromptAttachments(submittedAttachments);
      const isAuto = modelValue === AUTO_MODEL_VALUE;
      let resolvedAgent: string | null | undefined;
      let resolvedAutoDecision: AutoDecision | undefined;
      if (goalLoopEnabled) {
        if (files.length > 0) throw new Error("Goal loop の開始では画像のみ添付できます");
        stickRef.current = true;
        setPrompt("");
        setAttachments([]);
        draftCleared = true;
        setGoalLoopStarting(true);
        const startAbort = new AbortController();
        goalLoopStartAbortRef.current = startAbort;
        const startTaskId = taskId;
        const startEpoch = goalLoopActionEpochRef.current;
        const startControlSeq = goalLoopControlSeqRef.current;
        goalStartControlSeq = startControlSeq;
        try {
          const result = await sendJson<{
            loop: GoalLoopDto | null;
            agent?: string | null;
            autoDecision?: AutoDecision;
          }>(
            `/api/tasks/${taskId}/goal-loop`,
            {
              action: "start",
              goal: submittedPrompt,
              acceptance: goalLoopAcceptance,
              maxTurns: goalLoopMaxTurns,
              cooldownSeconds: goalLoopCooldownSeconds,
              forceFullRun: goalLoopForceFullRun,
              images,
              ...(agentSelection ? { agent: agentSelection } : {}),
              ...(isAuto
                ? {
                    auto: true,
                    autoOptimize: autoOptimizeMode,
                    autoRouteOverrides: autoRouteConfig,
                  }
                : {}),
            },
            "POST",
            { signal: startAbort.signal },
          );
          if (startTaskId !== taskId || startEpoch !== goalLoopActionEpochRef.current) return;
          resolvedAgent = result.agent;
          resolvedAutoDecision = result.autoDecision;
          // Paused/stopped from the panel while the start reply was pending: that newer state wins.
          if (startControlSeq === goalLoopControlSeqRef.current) {
            setTask((current) => (current ? { ...current, goalLoop: result.loop } : current));
          }
          setGoalLoopEnabled(false);
        } finally {
          if (goalLoopStartAbortRef.current === startAbort) goalLoopStartAbortRef.current = null;
          if (startEpoch === goalLoopActionEpochRef.current) setGoalLoopStarting(false);
        }
      } else {
        // Only the explicit action on an already queued pill injects into the
        // current turn. working covers the prompt_accepted→stream gap.
        const streamingBehavior = queued && sendNow && working ? "steer" : undefined;
        if (!queued) {
          setPrompt("");
          setAttachments([]);
          draftCleared = true;
        }
        // An explicit send (typed or "今すぐ送信") follows the transcript to the bottom even when the
        // user had scrolled up; a queue auto-drain keeps their reading position.
        if (!queued || sendNow) stickRef.current = true;
        // Echo an idle send at once (attachments as previews); the owner's row replaces it when the
        // snapshot lands. Steering waits for a tool boundary, so it gets a pending notice instead.
        if (!streamingBehavior && !working && (submittedAttachments.length > 0 || submittedPrompt.trim())) {
          stickRef.current = true;
          setOptimisticPrompt({
            message: optimisticUserMessage(submittedPrompt, Date.now(), submittedAttachments),
            before: beforeSubmitMessages,
            accepted: false,
          });
        }
        if (streamingBehavior) {
          setPendingSteer({
            text: submittedPrompt.trim() || `添付 ${submittedAttachments.length} 件`,
            before: beforeSubmitMessages,
            accepted: false,
          });
        }
        const promptTimeoutMs = isAuto || agentSelection === AUTO_AGENT_VALUE
          ? LONG_PROMPT_SUBMIT_TIMEOUT_MS
          : PROMPT_SUBMIT_TIMEOUT_MS;
        const result = await sendTaskPrompt<{
          task: TaskSummary;
          autoDecision?: AutoDecision;
        }>(
          `/api/tasks/${taskId}/prompt`,
          {
            prompt: submittedPrompt,
            images,
            files,
            ...(isAuto
              ? {
                  auto: true,
                  autoOptimize: autoOptimizeMode,
                  autoRouteOverrides: autoRouteConfig,
                }
              : {}),
            ...(agentSelection ? { agent: agentSelection } : {}),
            ...(streamingBehavior ? { streamingBehavior, interruptIfSafe: true } : {}),
          },
          promptTimeoutMs,
        );
        resolvedAgent = result.task.agent ?? null;
        resolvedAutoDecision = result.autoDecision;
        setTask((current) => (current ? { ...current, ...result.task } : current));
        setOptimisticPrompt((current) => (current ? { ...current, accepted: true } : current));
        if (streamingBehavior) setPendingSteer((current) => (current ? { ...current, accepted: true } : current));
      }
      if (isAuto && resolvedAutoDecision) {
        const nextRecord: AutoTaskRecord = {
          decision: resolvedAutoDecision,
          ...(!images.length && !files.length && submittedPrompt.length <= AUTO_TASK_PROMPT_MAX
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
      if (!queued) setFailedQueuedId(null);
      notifyTasksChanged();
    } catch (err) {
      // A lost/invalid HTTP reply does not undo a prompt already accepted by the owner.
      // Reconcile against a fresh persisted user message, never against working=true.
      const unconfirmedDelivery = isUnconfirmedPromptDelivery(err);
      const deliveryReason = typeof err === "object" && err !== null && "reason" in err && typeof err.reason === "string"
        ? err.reason
        : "unknown";
      if (!goalLoopEnabled && submittedAttachments.length === 0 && unconfirmedDelivery) {
        let received = hasReceivedSubmittedPrompt(beforeSubmitMessages, messagesRef.current, submittedPrompt);
        if (!received) {
          const retryUntil = Date.now() + (
            deliveryReason === "timeout" ? PROMPT_DELIVERY_RECONCILE_TIMEOUT_MS : PROMPT_DELIVERY_READ_TIMEOUT_MS
          );
          let retryDelayMs = PROMPT_DELIVERY_RETRY_INITIAL_DELAY_MS;
          while (!received) {
            if (hasReceivedSubmittedPrompt(beforeSubmitMessages, messagesRef.current, submittedPrompt)) {
              received = true;
              break;
            }
            const remainingMs = retryUntil - Date.now();
            if (remainingMs <= 0) break;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const response = await Promise.race([
                getJson<{ task: TaskDetail }>(`/api/tasks/${taskId}`, { messages: "page" }, {
                  coalesce: false,
                  signal: controller.signal,
                }).catch(() => null),
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => {
                    controller.abort();
                    resolve(null);
                  }, Math.min(PROMPT_DELIVERY_READ_TIMEOUT_MS, remainingMs));
                }),
              ]);
              const detail = response?.task;
              if (detail?.id === taskId && Array.isArray(detail.messages)
                && hasReceivedSubmittedPrompt(beforeSubmitMessages, detail.messages, submittedPrompt)) {
                applyDetail(detail);
                received = true;
              }
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
            if (received || deliveryReason !== "timeout") break;
            const pauseMs = Math.min(retryDelayMs, Math.max(0, retryUntil - Date.now()));
            if (pauseMs <= 0) break;
            await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
            retryDelayMs = Math.min(retryDelayMs * 2, PROMPT_DELIVERY_RETRY_MAX_DELAY_MS);
          }
        }
        if (received) {
          if (!queued) setFailedQueuedId(null);
          notifyTasksChanged();
          return;
        }
      }
      // Not delivered (or unconfirmed after reconciliation): the echo must not suggest otherwise.
      // A reconciled delivery returned above and keeps it until the real row replaces it.
      setOptimisticPrompt(null);
      setPendingSteer(null);
      // The user already paused/stopped this loop from the panel while its start reply was
      // pending: the start's late failure is not news, and restoring the goal would re-arm it.
      if (
        goalLoopEnabled &&
        goalStartControlSeq !== null &&
        goalStartControlSeq !== goalLoopControlSeqRef.current
      ) {
        setGoalLoopEnabled(false);
        setError(null);
        return;
      }
      restoreQueuedFollowUp();
      if (draftCleared) {
        setPrompt((current) => current || submittedPrompt);
        setAttachments((current) =>
          current.length > 0 ? current : submittedAttachments,
        );
      }
      // User cancelled Goal Loop start (or task switch aborted it): restore draft without an error banner.
      const cancelledStart = goalLoopEnabled && (
        (err instanceof Error && err.name === "AbortError")
        || (err instanceof Error && /キャンセル|タイムアウト/.test(err.message))
      );
      if (cancelledStart) {
        setGoalLoopEnabled(true);
        setError(null);
      } else {
        setError(unconfirmedDelivery
          ? `送信結果を確認できません。再送前に履歴を確認してください（${deliveryReason}）`
          : err instanceof Error ? err.message : "送信に失敗しました");
      }
    } finally {
      submitInFlightRef.current = false;
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
    const retryNotice = "Auto候補でエラーが発生したため別の候補で再試行しました";
    const retryThinkingLevel = autoVariantToThinkingLevel(escalation.variant);
    void sendJson(`/api/tasks/${taskId}/prompt`, {
      prompt: autoRecord.prompt,
      auto: true,
      autoRetry: true,
      model: autoModelValue(escalation),
      ...(retryThinkingLevel ? { thinkingLevel: retryThinkingLevel } : {}),
      ...(autoRecord.agent ? { agent: autoRecord.agent } : {}),
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
    task?.limitError,
    task?.status,
    taskId,
  ]);

  useEffect(() => {
    if (
      agentChanging ||
      archived ||
      !shouldDrainQueuedFollowUp({
        working,
        submitting,
        queuedAutoSend,
        goalLoopEnabled,
        // paused/blocked still own the session — same as goalLoopVisible.
        goalLoopLive: goalLoopVisible,
        stopRequested,
        hasQueuedItem: queuedFollowUps.length > 0,
        queueFailed: queuedFollowUps[0]?.id === failedQueuedId,
        resumingTurn,
        sessionHydrating,
        sseReconnecting,
        compacting,
        submitInFlight: submitInFlightRef.current,
        revertBusy,
        revertConfirmOpen,
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
    agentChanging,
    archived,
    compacting,
    goalLoopEnabled,
    goalLoopVisible,
    queuedAutoSend,
    queuedFollowUps,
    failedQueuedId,
    resumingTurn,
    revertBusy,
    revertConfirmOpen,
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
        goalLoopLive: goalLoopVisible,
        stopRequested,
        hasContent: Boolean(queuedSendRef.current),
        resumingTurn,
        sessionHydrating,
        sseReconnecting,
        compacting,
        submitInFlight: submitInFlightRef.current,
        revertBusy,
        revertConfirmOpen,
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
    goalLoopVisible,
    prompt,
    queuedAutoSend,
    resumingTurn,
    revertBusy,
    revertConfirmOpen,
    sessionHydrating,
    sseReconnecting,
    stopRequested,
    submitting,
    working,
  ]);

  async function goalLoopAction(action: "pause" | "resume" | "stop" | "complete", maxTurns?: number) {
    // A composer Stop in flight already ends the loop; a racing panel action would only 409.
    if (archived || goalLoopSubmitting || abortInFlightRef.current) return;
    const actionTaskId = taskId;
    const actionEpoch = goalLoopActionEpochRef.current;
    const halting = (action === "pause" || action === "stop") && working ? action : null;
    setGoalLoopSubmitting(true);
    // Immediate feedback in the WorkingRow while the owner aborts the running loop turn.
    if (halting) setGoalLoopHalting(halting);
    setError(null);
    try {
      const result = await sendJson<{ loop: GoalLoopDto | null }>(
        `/api/tasks/${taskId}/goal-loop`,
        { action, ...(maxTurns !== undefined ? { maxTurns } : {}) },
        "PATCH",
      );
      if (actionTaskId !== taskId || actionEpoch !== goalLoopActionEpochRef.current) return;
      goalLoopControlSeqRef.current += 1;
      if (action === "resume") {
        // Prior Stop left stopRequested latched; resume starts a new run.
        stopRequestedRef.current = false;
        setStopRequested(false);
        setGoalLoopHalting(null);
      }
      if (action === "stop") {
        // Stopping the loop must not start the queued next prompt when it goes idle.
        queueClearEpochRef.current += 1;
        setQueuedFollowUps([]);
        queuedSendRef.current = null;
        setQueuedAutoSend(false);
      }
      if (action === "pause" || action === "stop") {
        // Pause/Stop abort the loop turn on the owner, which settles its permission/question
        // prompts. Drop the cards now (latched, like composer Stop) so a lagging or dropped SSE
        // cannot leave an answerable card for a turn that no longer exists.
        setPermissionRequest((current) => {
          if (current) clearedPermissionIdsRef.current.add(current.id);
          return null;
        });
        setQuestionRequest((current) => {
          if (current) clearedQuestionIdsRef.current.add(current.id);
          return null;
        });
        setPermissionBusy(false);
      }
      setTask((current) => (current ? { ...current, goalLoop: result.loop } : current));
      notifyTasksChanged();
    } catch (err) {
      if (actionTaskId !== taskId || actionEpoch !== goalLoopActionEpochRef.current) return;
      setGoalLoopHalting(null);
      // A composer Stop pressed meanwhile ended the loop; its 409 is not news.
      if (stopRequestedRef.current && action !== "resume") return;
      const fallback = err instanceof Error ? err.message : "Goal loop の操作に失敗しました";
      // The loop may have moved on by itself (completed / paused by the owner / another tab).
      // Resync the panel instead of leaving a stale state with a raw 409 under it.
      let refreshed: GoalLoopDto | null | undefined;
      try {
        refreshed = (await getJson<{ loop: GoalLoopDto | null }>(
          `/api/tasks/${actionTaskId}/goal-loop`,
          undefined,
          { coalesce: false },
        )).loop;
      } catch {
        refreshed = undefined;
      }
      if (actionTaskId !== taskId || actionEpoch !== goalLoopActionEpochRef.current) return;
      if (refreshed !== undefined) {
        goalLoopControlSeqRef.current += 1;
        setTask((current) => (current ? { ...current, goalLoop: refreshed } : current));
        if (goalLoopActionSatisfied(action, refreshed)) {
          notifyTasksChanged();
          return;
        }
        setError(goalLoopActionConflictMessage(action, refreshed) ?? fallback);
        return;
      }
      setError(fallback);
    } finally {
      if (actionEpoch === goalLoopActionEpochRef.current) setGoalLoopSubmitting(false);
    }
  }

  async function compact() {
    if (compacting || archived) return;
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
      // 失敗時は SSE で isCompacting が戻らないので、ここで解除しないと送信が永久ブロックされる。
      setIsCompacting(false);
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
      // compact() の finally より先に戻す。await 中の compactingLocal が残ると送信が最大数分ブロックされる。
      setCompactingLocal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮のキャンセルに失敗しました");
      // abort API 失敗時も UI フラグを落とさないと、送信が永久ブロックされる。
      setCompactingLocal(false);
      setIsCompacting(false);
    }
  }

  async function abortWorking() {
    if (archived || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setStopRequested(true);
    abortInFlightRef.current = true;
    setAbortInFlight(true);
    // stopRequested already blocks drain/auto-send. Clear client-only queues only
    // after abort succeeds so a failed stop does not drop queued follow-ups.
    try {
      setError(null);
      const result = await sendJson<{ task: TaskSummary }>(`/api/tasks/${taskId}/abort`, {});
      queueClearEpochRef.current += 1;
      setQueuedFollowUps([]);
      queuedSendRef.current = null;
      setQueuedAutoSend(false);
      // TaskSummary does not include the live-session flag. Clear it here so
      // one successful stop cannot leave the local `working` state stale.
      // Also merge goalLoopSummary into the full GoalLoopDto so the panel cannot
      // stay on running until the next SSE snapshot.
      setTask((current) => {
        if (!current) return current;
        // Abort stops the Goal Loop. Prefer the summary from the response; if it is
        // missing, still drop a live panel state to stopped so Stop cannot stick.
        const summary = result.task.goalLoopSummary ?? (
          current.goalLoop
            ? {
                status: "stopped" as const,
                maxTurns: current.goalLoop.maxTurns,
                turnCount: current.goalLoop.turnCount,
              }
            : undefined
        );
        const goalLoop = applyGoalLoopSummaryToDetail(current.goalLoop, summary);
        return {
          ...current,
          ...result.task,
          isStreaming: false,
          ...(goalLoop !== current.goalLoop ? { goalLoop } : {}),
        };
      });
      // Abort clears server attention; if SSE is down the permission/question
      // cards would otherwise stick until a later snapshot. Latch ids so a
      // stale reconnect snapshot cannot revive the same cards.
      setPermissionRequest((current) => {
        if (current) clearedPermissionIdsRef.current.add(current.id);
        return null;
      });
      setQuestionRequest((current) => {
        if (current) clearedQuestionIdsRef.current.add(current.id);
        return null;
      });
      setPermissionBusy(false);
      notifyTasksChanged();
    } catch (err) {
      stopRequestedRef.current = false;
      setStopRequested(false);
      setError(err instanceof Error ? err.message : "停止に失敗しました");
    } finally {
      abortInFlightRef.current = false;
      setAbortInFlight(false);
    }
  }

  const resumeTurn = useCallback(async (target: ResumableTurn, manual = false) => {
    if (working || resumingTurn || archived) return false;
    // Auto-resume must not defeat a latched User Stop; manual Resume clears it below.
    if (!manual && stopRequestedRef.current) return false;
    const wasStopped = stopRequestedRef.current;
    if (manual) {
      stopRequestedRef.current = false;
      setStopRequested(false);
    }
    setResumeTurnError(null);
    setResumingTurn(true);
    stickRef.current = true;
    const resumeMode = readAutoResumeMode();
    const resumedPrompt = autoResumePrompt(resumeMode, target.text);
    try {
      const resumedAttachments = shouldAttachResumeImages(resumeMode, target.text, target.files.length)
        ? composerPromptAttachments(target.files)
        : { images: [], files: [] };
      const result = await sendJson<{ task: TaskSummary }>(`/api/tasks/${taskId}/prompt`, {
        prompt: resumedPrompt,
        images: resumedAttachments.images,
        files: resumedAttachments.files,
        resume: true,
        ...(target.model
          ? {
              model: target.model.accountId
                ? `${target.model.accountId}::${target.model.providerID}::${target.model.modelID}`
                : `${target.model.providerID}::${target.model.modelID}`,
            }
          : {}),
      });
      setTask((current) => (current ? { ...current, ...result.task } : current));
      setManualAbortedAssistantId(null);
      notifyTasksChanged();
      return true;
    } catch (err) {
      if (manual && wasStopped) {
        stopRequestedRef.current = true;
        setStopRequested(true);
      }
      setResumeTurnError(err instanceof Error ? err.message : "再開に失敗しました");
      return false;
    } finally {
      setResumingTurn(false);
    }
  }, [archived, resumingTurn, taskId, working]);

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
  const modelValue = resolveModelValue({
    modelSelection,
    hasAutoRecord: Boolean(autoRecord),
    accountTaskModelValue: accountTaskModel?.value,
    plainTaskModelValue,
    firstModelValue: models[0]?.value,
  });
  const modelOptions = useMemo(
    () => (autoModelEnabled || modelValue === AUTO_MODEL_VALUE ? [AUTO_MODEL_OPTION, ...models] : models),
    [autoModelEnabled, modelValue, models],
  );
  const selectedModel = modelOptionForValue(modelOptions, modelValue);
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
  // 発言完了（working → idle）タイミングで、直前の assistant メッセージだけ読み上げる。
  // 非表示ペイン（裏タブ等）は喋らない。完了通知が履歴更新より先に届いても待つ。
  const prevWorkingTtsRef = useRef(working);
  const ttsBaselineAssistantIdRef = useRef<string | null>(null);
  const ttsPendingRef = useRef(false);
  const ttsTaskIdRef = useRef(taskId);
  useEffect(() => {
    if (ttsTaskIdRef.current !== taskId) {
      ttsTaskIdRef.current = taskId;
      prevWorkingTtsRef.current = working;
      ttsBaselineAssistantIdRef.current = null;
      ttsPendingRef.current = false;
      return;
    }
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!prevWorkingTtsRef.current && working) {
      ttsBaselineAssistantIdRef.current = lastAssistant?.id ?? null;
      ttsPendingRef.current = false;
    } else if (prevWorkingTtsRef.current && !working) {
      ttsPendingRef.current = Boolean(ttsEnabled && active);
    }
    if (!ttsEnabled || !active) ttsPendingRef.current = false;
    if (!working && ttsPendingRef.current && lastAssistant && lastAssistant.id !== ttsBaselineAssistantIdRef.current) {
      ttsPendingRef.current = false;
      const text = lastAssistant.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
      speakText(text, { botId: task?.botId, onError: setTtsError, onPlayed: () => setTtsError(null) });
    }
    prevWorkingTtsRef.current = working;
  }, [active, task?.botId, taskId, working, ttsEnabled, messages]);
  // 注意音：承認 UI の立上がりエッジ。タブの可視状態に関係なく鳴らす。
  const prevAttentionSoundRef = useRef(false);
  useEffect(() => {
    if (!prevAttentionSoundRef.current && attention) playAttentionRequiredSound();
    prevAttentionSoundRef.current = attention;
  }, [attention]);

  const notificationDeliveryEnabled = useNotificationDeliveryEnabled();
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
    if (!notificationDeliveryEnabled) {
      pendingKindRef.current = null;
      prevAttentionNotifyRef.current = attention;
      prevWorkingNotifyRef.current = working;
      return;
    }
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
    notificationDeliveryEnabled,
    permissionTick,
  ]);
  // ナビゲーターのジャンプ対象: ユーザーメッセージを優先し、Goal Loop の
  // hidden custom message しかない履歴では投影済みメッセージへフォールバックする。
  // 表示用フィルタとヘッダー統計はこの memo でまとめて集計し、履歴を走査する memo を増やさない。
  const {
    visibleMessages,
    userMessageIds,
    navigationMessageIds,
    stats,
  } = useMemo(() => {
    const visible: UiMessage[] = [];
    const userIds: string[] = [];
    const fallbackIds: string[] = [];
    let durationMs = 0;
    let prevCreatedAt: number | null = null;
    for (const message of messages) {
      // Hang-retry prompts are hidden from the timeline; the notice uses the
      // live server counter (see hangRetryNoticeCount), not a transcript tally.
      if (isHangRetryUserMessage(message)) continue;
      visible.push(message);
      if (message.role === "user") userIds.push(message.id);
      else if (message.role !== "compaction") fallbackIds.push(message.id);
      if (message.role === "user" || message.role === "compaction") continue;
      if (prevCreatedAt !== null) {
        durationMs += Math.max(0, message.createdAt - prevCreatedAt);
      }
      prevCreatedAt = message.createdAt;
    }
    // 平均 tok/s は全応答が対象（メッセージヘッダーに tok/s が出ない作業ログ先頭の応答も含む）。
    const { outputTokens: totalOutputTokens, avgRate } = summarizeThroughput(visible);
    return {
      visibleMessages: visible,
      userMessageIds: userIds,
      navigationMessageIds: userIds.length > 0 ? userIds : fallbackIds,
      stats: {
        totalOutputTokens,
        avgRate,
        durationMs: messages.length > 1 ? durationMs : 0,
      },
    };
  }, [messages]);
  const renderedMessages = visibleMessages;
  // Pending send chrome (echo / POST in flight) without touching `working` sound/TTS gates.
  const pendingTurn = Boolean(promptSubmitting || optimisticVisible);
  const showWorkingChrome = working || pendingTurn;
  // A Stop (composer or Goal Loop panel) must stay visible even while text streams: the row is
  // hidden behind a streaming tail otherwise, and the press looked like it did nothing.
  const haltPending = working && (stopRequested || goalLoopHalting !== null);
  const showWorkingRow = shouldShowWorkingRow(
    showWorkingChrome,
    renderedMessages,
    optimisticVisible || haltPending,
  );
  // While the echo stands in for this turn the transcript tail is the previous turn: time the row
  // from the send, not from an old message (which painted a red multi-minute clock at once).
  const workingRowStartedAt = optimisticVisible ? optimisticPrompt?.message.createdAt : undefined;
  const workingRowLabel = stopRequested
    ? "停止しています…"
    : working && goalLoopHalting === "stop"
      ? "Goal Loop を停止しています…"
      : working && goalLoopHalting === "pause"
        ? "Goal Loop を一時停止しています…"
        : pendingTurn && !working
          ? "送信しています…"
          : undefined;
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
    !goalLoopVisible &&
    // User Stop latches stopRequested to block silent auto-resume / drain.
    !stopRequested;
  useEffect(() => {
    if (
      !settledSilentMessageId ||
      !showResume ||
      resumeTarget?.reason !== "silent" ||
      resumeTarget.messageId !== settledSilentMessageId
    ) return;
    const key = `${taskId}:${resumeTarget.messageId}`;
    if (autoResumeKeyRef.current === key) return;
    autoResumeKeyRef.current = key;
    void resumeTurn(resumeTarget).then((ok) => {
      if (!ok && autoResumeKeyRef.current === key) autoResumeKeyRef.current = null;
    });
  }, [resumeTarget, resumeTurn, settledSilentMessageId, showResume, taskId]);
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
  const avgRateLabel = stats.avgRate === null ? null : formatTokensPerSecond(stats.avgRate);
  // 幅狭はラベル行、幅広は状態行に同じ使用量（合計出力tok → 平均tok/s → 合計時間）を出す。
  const usageStats = (visibility: string) => (
    <>
      {stats.totalOutputTokens > 0 && (
        <span className={cx("tabular-nums", visibility)} title="合計出力トークン">
          {formatTokens(stats.totalOutputTokens)} tok
        </span>
      )}
      {avgRateLabel && (
        <span className={cx("tabular-nums", visibility, isSlowTokensPerSecond(stats.avgRate) && "text-danger")} title="平均 tok/s（全応答の tok/s の平均）">
          {avgRateLabel}
        </span>
      )}
      {stats.durationMs > 0 && (
        <span className={cx("tabular-nums", visibility)} title="合計生成時間（メッセージ間隔の累計）">
          {formatDuration(stats.durationMs)}
        </span>
      )}
    </>
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
  // Prefer the live server counter (reset on the next real turn). Do not use the
  // transcript-wide hang-retry tally — that kept the banner up forever.
  const autoHangRetryCount = hangRetryNoticeCount(hangRetryCount, messages);
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
    () => messageModelLabels(models),
    [models],
  );
  // モデル一覧の読み込み状態に関係なく、タスクへ実際に保存されたeffortを表示する。
  const effortLabel = thinkingLevelMetaLabel(task?.thinkingLevel);

  const navigationTargetLabel = userMessageIds.length > 0 ? "ユーザーメッセージ" : "メッセージ";
  navigationMessageIdsRef.current = navigationMessageIds;

  const displayedStatus = task
    ? working
      ? "working"
      : task.status === "idle" && worktreeStatus
        ? worktreeStatus
        : task.status
    : null;
  const supervisor = task?.supervisorBotId
    ? botFor?.(task.supervisorBotId) ?? supervisorBots.find((bot) => bot.id === task.supervisorBotId)
    : undefined;
  // Bot送信プロンプトの送信者。Bot開始セッションは所有Bot、ユーザー開始の監督中タスクは監督Bot。
  const senderBot = task?.botId ? botFor?.(task.botId) : supervisor;
  const canManageSupervisor = Boolean(
    task &&
      task.kind !== "bot" &&
      !task.botId &&
      !archived,
  );
  const hasSupervisor = Boolean(task?.supervisorBotId);
  const hasEligibleSupervisorBot = supervisorBots.some((bot) => bot.enabled && bot.permissionMode !== "deny");
  const supervisorControlDisabled = supervisorBusy || (!hasSupervisor && (!working || !hasEligibleSupervisorBot));
  const mobilePanelOpen = !mdUp && (graphOpen || diffOpen);
  const toggleFind = () => {
    if (find.open) {
      find.closePanel();
      return;
    }
    // 狭幅ではグラフ/Diffパネルがタイムラインを覆うので、検索を始めるときに閉じる。
    if (mobilePanelOpen) setPanelState({ graphOpen: false, diffOpen: false });
    find.openPanel();
  };

  return (
    // min-h-0 flex-1: ペイン section が TaskTabs を持つ場合でも残り高さに収める。
    // h-full だとタブバー分だけはみ出し composer 下端が overflow-hidden で欠ける。
    <div
      ref={taskViewRef}
      data-task-view=""
      className={cx("@container/task flex min-h-0 min-w-0 flex-1 flex-col bg-bot-chat", !active && "hidden")}
    >
      <header
        className="relative z-40 grid min-h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-b border-bot-outline bg-bot-chat px-3 pb-0.5 @min-[500px]/task:px-4"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="col-span-2 flex min-w-0 translate-y-1 items-center gap-2">
          {/* 44pxタップ領域は維持し、アイコン中心を下段のプロジェクトアイコン(24px)中心へ揃える */}
          <MobileMenuButton className="-ml-2.5 -mr-1.5" />
          <div className="flex min-w-0 flex-1 flex-col justify-center">
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
                  className="h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-bg px-2 text-base font-semibold text-text outline-none focus:border-accent @min-[500px]/task:h-8 @min-[500px]/task:text-sm"
                  disabled={titleBusy}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 @min-[500px]/task:h-8 @min-[500px]/task:w-8"
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
                  className="h-11 w-11 @min-[500px]/task:h-8 @min-[500px]/task:w-8"
                  aria-label="タイトル編集をキャンセル"
                  title="キャンセル"
                  disabled={titleBusy}
                  onClick={cancelTitleEdit}
                >
                  <X className="h-4 w-4" />
                </Button>
              </form>
            ) : (
              <h1
                className={cx(
                  "min-w-0 max-w-full rounded-lg text-left text-sm font-semibold @min-[500px]/task:flex @min-[500px]/task:min-h-8 @min-[500px]/task:items-center @min-[500px]/task:gap-2",
                  task && !archived && !titleBusy && "cursor-text",
                )}
                aria-label={task?.title ?? "読み込み中…"}
                tabIndex={task && !archived && !titleBusy ? 0 : undefined}
                title={task?.title}
                onDoubleClick={beginTitleEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    beginTitleEdit();
                  }
                }}
              >
                {task && (
                  <span className="hidden shrink-0 @min-[500px]/task:inline-flex">
                    <SessionLabelBadge labelId={task.label} className="w-11 text-center font-normal" />
                  </span>
                )}
                <span className="block min-w-0 max-w-full truncate leading-5 @min-[500px]/task:flex-1">{task?.title ?? "読み込み中…"}</span>
              </h1>
            )}
            <div aria-label="セッション情報" className="flex h-4 min-w-0 items-center gap-2 overflow-hidden text-[10px] text-muted @min-[500px]/task:hidden">
              <SessionLabelBadge labelId={task?.label} className="w-11 text-center font-normal" />
              {contextUsage && (
                <span className="min-w-0 @min-[500px]/task:hidden">
                  <ContextUsageMeter usage={contextUsage} />
                </span>
              )}
              {usageStats("shrink-0")}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="タイトルを生成"
            title="会話内容からタイトルを生成"
            className="h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9"
            disabled={!task || archived || titleBusy}
            busy={titleBusy}
            onClick={() => void refreshTitle()}
          >
            {!titleBusy && <WandSparkles className="h-4 w-4" />}
          </Button>
        </div>
        <div aria-label="タスクの状態" className="col-span-1 col-start-1 row-start-2 flex min-w-0 items-center gap-x-2 overflow-hidden text-xs text-muted @max-[500px]/task:-translate-y-0.5">
          <span aria-label="プロジェクトアイコン" className="inline-flex shrink-0">{iconFor(taskId, 24, task ?? undefined)}</span>
          {permissionRequest && <Badge tone="warning" className="shrink-0">承認待ち</Badge>}
          {questionRequest && <Badge tone="warning" className="shrink-0">回答待ち</Badge>}
          {/* 狭幅では承認・回答待ちバッジを優先し、同時に出る「実行中」は省いて切れを防ぐ。 */}
          {displayedStatus && (
            <StatusBadge
              status={displayedStatus}
              className={cx(
                "min-w-0",
                displayedStatus === "working" &&
                  (permissionRequest || questionRequest) &&
                  "@max-[500px]/task:hidden",
              )}
            />
          )}
          {supervisor && !canManageSupervisor && (
            <span
              title={`監督: ${supervisor.name}`}
              className="shrink-0 rounded-full ring-1 ring-working/25"
            >
              <BotAvatar size={20} {...supervisor} active={working} />
            </span>
          )}
          {contextUsage && (
            <span className="hidden @min-[500px]/task:flex">
              <ContextUsageMeter usage={contextUsage} />
            </span>
          )}
          {usageStats("hidden @min-[500px]/task:inline")}
        </div>
        <div
          role="group"
          aria-label="タスク操作"
          className="flex items-center justify-end col-start-2 row-start-2"
        >
          <Button
            variant="ghost"
            size="icon"
            title="セッション内を検索（Ctrl+F）"
            aria-label="セッション内を検索"
            aria-pressed={find.open}
            disabled={!task}
            className={cx(
              "h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9",
              find.open && "bg-surface-2 text-text",
            )}
            onClick={toggleFind}
          >
            <Search className="h-4 w-4" />
          </Button>
          {onAddPane && (
            <Button
              variant="ghost"
              size="icon"
              title="新しいペインを追加"
              aria-label="新しいペインを追加"
              className="h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9 @max-[500px]/task:hidden"
              onClick={onAddPane}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title="コンテキスト圧縮"
            aria-label="コンテキスト圧縮"
            busy={compacting}
            disabled={!task || working || compacting || archived}
            className="h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9"
            onClick={() => void compact()}
          >
            {!compacting && <Shrink className="h-4 w-4" />}
          </Button>
          {canManageSupervisor && (
            <label
              title={supervisor ? `監督: ${supervisor.name}` : hasSupervisor ? "委任を解除" : working ? "Botへ引き継ぐ" : "タスク実行中にBotへ引き継げます"}
              className={cx(
                "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text focus-within:ring-2 focus-within:ring-accent @min-[500px]/task:h-9 @min-[500px]/task:w-9",
                supervisorControlDisabled && "cursor-not-allowed opacity-40",
              )}
            >
              <span className="sr-only">Codeタスクを監督するBot</span>
              {supervisor ? <BotAvatar size={20} {...supervisor} active={working} /> : <BotAvatar size={20} avatarColor="currentColor" />}
              <select
                aria-label="Codeタスクを監督するBot"
                defaultValue=""
                disabled={supervisorControlDisabled}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === USER_OWNERSHIP_OPTION) void setSupervisor(null);
                  else if (value) void setSupervisor(value);
                  event.currentTarget.value = "";
                }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              >
                <option value="">{hasSupervisor ? "委任を解除…" : "Botへ引き継ぐ…"}</option>
                {hasSupervisor ? (
                  <option value={USER_OWNERSHIP_OPTION}>委任を解除（ユーザー所有）</option>
                ) : supervisorBots.filter((bot) => bot.enabled && bot.permissionMode !== "deny").map((bot) => (
                  <option key={bot.id} value={bot.id}>{bot.name}</option>
                ))}
              </select>
            </label>
          )}
          {ttsGlobalEnabled && (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={ttsEnabled}
                aria-label="読み上げ"
                title={ttsEnabled ? "読み上げ: ON" : "読み上げ: OFF"}
                onClick={toggleTts}
                className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg @min-[500px]/task:h-9 @min-[500px]/task:w-9 ${ttsEnabled ? "text-accent" : "text-muted"} hover:bg-surface-2 hover:text-text`}
              >
                {ttsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              {ttsError && <span role="alert" title={ttsError} className="max-w-24 shrink-0 truncate text-[11px] text-danger @min-[500px]/task:max-w-40">{ttsError}</span>}
            </>
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
              "h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9",
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
              "h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9",
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
      {find.open && <TaskFindPanel key={taskId} taskId={taskId} find={find} />}
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cx(
            conversationViewportClass,
            mobilePanelOpen && "hidden",
          )}
        >
          <div ref={contentRef} className={conversationContentClass}>
            {hangRetryNotice && (
              <p className="rounded-card border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
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
            {messageHistory.hasMore && (
              <div className="flex flex-col items-center gap-1 py-1" role="status" aria-live="polite">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadOlderMessages()}
                  busy={historyLoading}
                  disabled={historyLoading}
                >
                  {!historyLoading && <ChevronsUp aria-hidden="true" className="h-3.5 w-3.5" />}
                  {historyLoading ? "過去の履歴を読み込み中…" : "過去の履歴を読み込む"}
                </Button>
                {historyError && <span className="text-xs text-danger">{historyError}</span>}
              </div>
            )}
            {messageBlocks.map((block, blockIndex) => {
              const firstMessage = block.kind === "tool-group" ? block.entries[0]!.message : block.message;
              const turn = block.showTurnDivider ? firstMessage.goalLoopTurn : undefined;
              const activityHeader =
                block.kind === "tool-group"
                  ? (() => {
                      const entry = block.entries[0]!;
                      const message = entry.message;
                      const modelLabel = messageModelLabel(message, modelLabels);
                      const accountLabel = message.accountId
                        ? (accountLabels.get(message.accountId) ?? message.accountId)
                        : (taskAccountLabel ?? undefined);
                      // The group header carries the whole log's usage; the summary keeps only the count.
                      return function renderActivityHeader(usage: ActivityUsage, placement: "outside" | "inside") {
                        return (
                          <MessageHeader wide>
                            <MessageMetaHeader
                              message={message}
                              modelLabel={modelLabel}
                              effort={effortLabel}
                              agent={message.agent ?? task?.agent ?? undefined}
                              hideDefaultAgent={hideDefaultAgentInMeta}
                              accountLabel={accountLabel}
                              usage={usage}
                              singleLine
                              showAccountInSingleLine
                              bubbleAligned={placement === "outside"}
                            />
                          </MessageHeader>
                        );
                      };
                    })()
                  : undefined;
              const renderActivityContents =
                block.kind === "tool-group"
                  ? () => block.entries.flatMap((entry, entryIndex) => {
                      const message = entry.activityMessage;
                      const modelLabel = messageModelLabel(message, modelLabels);
                      const accountLabel = message.accountId
                        ? (accountLabels.get(message.accountId) ?? message.accountId)
                        : (taskAccountLabel ?? undefined);
                      // 先頭のメタ行は折りたたみ状態でも応答元が分かるよう枠外へ出し、
                      // 後続メッセージのメタ行だけ展開内容に残す。
                      const header = entryIndex > 0 && entry.showHeader
                        ? [
                            <MessageHeader wide key={`task-tool-message-meta:${messageRenderKey(entry.message)}`}>
                              <MessageMetaHeader
                                message={entry.message}
                                modelLabel={modelLabel}
                                effort={effortLabel}
                                agent={entry.message.agent ?? task?.agent ?? undefined}
                                hideDefaultAgent={hideDefaultAgentInMeta}
                                accountLabel={accountLabel}
                                singleLine
                                showAccountInSingleLine
                              />
                            </MessageHeader>,
                          ]
                        : [];
                      const toolParts = message.parts.filter(
                        (part): part is TaskToolPart => part.type === "tool",
                      );
                      if (
                        toolParts.length === message.parts.length &&
                        toolParts.length > 0 &&
                        !message.error &&
                        (message.diagnostics?.length ?? 0) === 0
                      ) {
                        return [
                          ...header,
                          ...toolParts.map((part) => {
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
                          }),
                        ];
                      }
                      return [
                        ...header,
                        <PartView
                          key={`task-tool-message:${messageRenderKey(entry.message)}`}
                          message={message}
                          modelLabel={modelLabel}
                          effort={effortLabel}
                          agent={message.agent ?? task?.agent ?? undefined}
                          accountLabel={accountLabel}
                          references={messageReferences}
                          taskId={taskId}
                          active={active}
                          reasoningActive={working && renderedMessages.at(-1)?.id === entry.message.id && entry.message.parts.at(-1)?.type === "thinking"}
                          hideMeta
                        />,
                      ];
                    })
                  : undefined;
              const activityCount =
                block.kind === "tool-group"
                  ? block.entries.reduce((count, entry) => count + taskActivityCount(entry), 0)
                  : 0;
              const nextBlock = messageBlocks[blockIndex + 1];
              const runningLog = working && block.kind === "tool-group" && (
                blockIndex === messageBlocks.length - 1 ||
                (blockIndex === messageBlocks.length - 2 && nextBlock?.kind === "message" && nextBlock.message.id === block.entries.at(-1)?.message.id)
              );
              return (
                <div
                  key={
                    block.kind === "tool-group"
                      ? `task-tool-group:${messageRenderKey(firstMessage)}`
                      : messageRenderKey(block.message)
                  }
                  className="task-message-row"
                  // 検索・ブックマークのジャンプ用。作業ログは畳まれていても、含むメッセージを引ける。
                  data-message-ids={
                    block.kind === "tool-group"
                      ? block.entries.map((entry) => entry.message.id).join(" ")
                      : block.message.id
                  }
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
                    <ActivityLog
                      kind="task"
                      header={activityHeader}
                      count={activityCount}
                      parts={block.entries.flatMap((entry) => entry.activityMessage.parts)}
                      // 本文を吹き出しへ出す応答（showHeader=false）は使用量もそちらのヘッダーに出るので数えない。
                      messages={block.entries.filter((entry) => entry.showHeader).map((entry) => entry.message)}
                      statusMessages={block.entries.map((entry) => entry.message)}
                      active={active}
                      running={runningLog}
                      renderChildren={renderActivityContents}
                      revealNonce={
                        find.reveal && block.entries.some((entry) => entry.message.id === find.reveal?.messageId)
                          ? find.reveal.nonce
                          : undefined
                      }
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
                      modelLabel={messageModelLabel(block.message, modelLabels)}
                      effort={block.message.role === "assistant" ? effortLabel : undefined}
                      agent={
                        block.message.role === "assistant"
                          ? block.message.agent ?? task?.agent ?? undefined
                          : undefined
                      }
                      hideDefaultAgent={hideDefaultAgentInMeta}
                      accountLabel={
                        block.message.role === "assistant"
                          ? block.message.accountId
                            ? (accountLabels.get(block.message.accountId) ?? block.message.accountId)
                            : (taskAccountLabel ?? undefined)
                          : undefined
                      }
                      bot={isBotSentUserMessage(block.message, task?.botId) ? senderBot : undefined}
                      references={messageReferences}
                      taskId={taskId}
                      active={active}
                      reasoningActive={working && renderedMessages.at(-1)?.id === block.message.id && block.message.parts.at(-1)?.type === "thinking"}
                      streaming={working && renderedMessages.at(-1)?.id === block.message.id && block.message.role === "assistant"}
                      onRevert={block.message.role === "user" ? requestRevert : undefined}
                      bookmarked={find.bookmarkedIds.has(block.message.id)}
                      onToggleBookmark={isStableMessageId(block.message.id) ? find.toggleBookmark : undefined}
                    />
                  )}
                </div>
              );
            })}
            {optimisticVisible && optimisticPrompt && (
              <div className="task-message-row opacity-70" aria-busy="true" data-optimistic-prompt>
                <PartView
                  message={optimisticPrompt.message}
                  references={messageReferences}
                  taskId={taskId}
                  active={active}
                />
              </div>
            )}
            {showResume && !resumeInsideExistingBanner && resumeTarget && (
              <TurnNoticeBanner
                message={resumeBannerText}
                action={resumeAction}
                actionError={resumeTurnError}
                tone={resumeTarget.reason === "silent" ? "neutral" : "danger"}
              />
            )}
            {showWorkingRow && (
              <WorkingRow
                messages={renderedMessages}
                active={active}
                startedAtMs={workingRowStartedAt}
                label={workingRowLabel}
              />
            )}
            {task?.todos && <TodoProgressPanel todos={task.todos} />}
            {!archived && <SessionResumePanel reservation={task?.sessionResume} />}
            {goalLoopVisible && !archived && (
              <GoalLoopPanel
                loop={task?.goalLoop}
                // Composer Stop in flight already ends the loop: no racing panel controls.
                busy={goalLoopSubmitting || abortInFlight}
                awaitingInput={permissionRequest ? "permission" : questionRequest ? "question" : undefined}
                onAction={(action) => void goalLoopAction(action)}
                onResume={(maxTurns) => void goalLoopAction("resume", maxTurns)}
              />
            )}
            {renderedMessages.length === 0 && !optimisticVisible && (
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
        {/* 提案・進捗確認とメッセージ移動。移動ボタン間より広い間隔で操作を分ける。 */}
        {(task?.sessionId || navigationMessageIds.length > 0) && (
          <div className={cx(
            "absolute right-4 bottom-4 z-30 flex flex-col items-center gap-6",
            mobilePanelOpen && "hidden",
          )}>
            {navigationMessageIds.length > 0 && (
              <div className="flex flex-col gap-2">
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
            {task?.sessionId && !working && (
              <NextAction
                taskId={taskId}
                sessionId={task.sessionId}
                panelRef={nextActionPanelRef}
                model={selectedModel?.value === AUTO_MODEL_VALUE ? undefined : selectedModel}
                invalidateKey={`${messages.length}:${messages.at(-1)?.id ?? ""}:${working ? "working" : "idle"}`}
                disabled={compacting || archived}
                triggerOpacity={scrollButtonOpacity}
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
            )}
            {task?.sessionId && working && (
              <TaskProgressAsk
                taskId={taskId}
                sessionId={task.sessionId}
                panelRef={progressPanelRef}
                model={selectedModel?.value === AUTO_MODEL_VALUE ? undefined : selectedModel}
                revision={`${messages.at(-1)?.id ?? ""}:${messages.at(-1)?.parts.length ?? 0}:${working ? "working" : "idle"}`}
                triggerOpacity={scrollButtonOpacity}
              />
            )}
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
              sessionId={task.sessionId}
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
        {compactionSuggested && !working && !compacting && !archived && (
          <div role="status" aria-live="polite" className="mx-auto mb-2 max-w-5xl">
            <TurnNoticeBanner
              message="コンテキスト使用率が閾値に達しました。圧縮をおすすめします。"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void compact()}
                >
                  今すぐ圧縮
                </Button>
              }
              tone="neutral"
            />
          </div>
        )}
        {permissionRequest && (
          <div
            role="alertdialog"
            aria-label="危険なコマンドの確認"
            className="mx-auto mb-2 max-w-5xl rounded-card border border-warning/30 bg-warning-bg px-3 py-3 text-sm text-warning"
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
                  const answerEpoch = attentionEpochRef.current;
                  void (async () => {
                    try {
                      setPermissionBusy(true);
                      setError(null);
                      await sendJson(`/api/tasks/${taskId}/permission`, {
                        requestId: answeredId,
                        approved: true,
                      });
                      clearedPermissionIdsRef.current.add(answeredId);
                      setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
                    } catch (err) {
                      // Switched tasks meanwhile: this answer's error belongs to the old task.
                      if (answerEpoch !== attentionEpochRef.current) return;
                      const message = err instanceof Error ? err.message : "許可の送信に失敗しました";
                      setError(message);
                      if (/not found|見つかりません/i.test(message)) {
                        clearedPermissionIdsRef.current.add(answeredId);
                        setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
                      }
                    } finally {
                      if (answerEpoch === attentionEpochRef.current) setPermissionBusy(false);
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
                  const answerEpoch = attentionEpochRef.current;
                  void (async () => {
                    try {
                      setPermissionBusy(true);
                      setError(null);
                      await sendJson(`/api/tasks/${taskId}/permission`, {
                        requestId: answeredId,
                        approved: false,
                      });
                      clearedPermissionIdsRef.current.add(answeredId);
                      setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
                    } catch (err) {
                      // Switched tasks meanwhile: this answer's error belongs to the old task.
                      if (answerEpoch !== attentionEpochRef.current) return;
                      const message = err instanceof Error ? err.message : "拒否の送信に失敗しました";
                      setError(message);
                      if (/not found|見つかりません/i.test(message)) {
                        clearedPermissionIdsRef.current.add(answeredId);
                        setPermissionRequest((cur) => (cur?.id === answeredId ? null : cur));
                      }
                    } finally {
                      if (answerEpoch === attentionEpochRef.current) setPermissionBusy(false);
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
                  clearedQuestionIdsRef.current.add(answeredId);
                  setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                } catch (err) {
                  const message = err instanceof Error ? err.message : "回答の送信に失敗しました";
                  if (/not found|見つかりません/i.test(message)) {
                    clearedQuestionIdsRef.current.add(answeredId);
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
                  clearedQuestionIdsRef.current.add(answeredId);
                  setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                } catch (err) {
                  const message = err instanceof Error ? err.message : "拒否の送信に失敗しました";
                  if (/not found|見つかりません/i.test(message)) {
                    clearedQuestionIdsRef.current.add(answeredId);
                    setQuestionRequest((cur) => (cur?.id === answeredId ? null : cur));
                  }
                  throw err;
                }
              }}
            />
          </div>
        )}
        {isReverted && (
          <div className="mx-auto mb-2 flex max-w-5xl items-center gap-3 rounded-card border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning">
            <span className="min-w-0 flex-1">
              巻き戻し中（以降のメッセージは非表示）
            </span>
            <Button
              variant="secondary"
              size="sm"
              busy={revertBusy}
              disabled={revertBusy || working}
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
            className="mx-auto mb-2 max-w-5xl rounded-card border border-warning/30 bg-warning-bg px-3 py-3 text-sm text-warning"
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
          <div className="mx-auto mb-2 flex max-w-5xl items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            <span className="min-w-0 flex-1">
              コンテキストを圧縮しています… 完了まで数分かかることがあります
            </span>
            <Button variant="secondary" size="sm" onClick={() => void abortCompact()}>
              キャンセル
            </Button>
          </div>
        )}
        {(goalLoopStarting || goalLoopSubmitting) && !working && (
          <div role="status" className="mx-auto mb-2 flex max-w-5xl items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            <span className="min-w-0 flex-1">
              {goalLoopStarting
                ? "Goal Loop を開始しています…"
                : "Goal Loop を操作しています…"}
            </span>
            {goalLoopStarting && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  goalLoopStartAbortRef.current?.abort();
                }}
              >
                キャンセル
              </Button>
            )}
          </div>
        )}
        {task?.goalLoop?.status === "queued" && !working && !goalLoopSubmitting && !goalLoopStarting && (
          <p role="status" className="mx-auto mb-2 max-w-5xl rounded-card border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            クールタイム中です。送信すると Goal Loop が一時停止します。
          </p>
        )}
        {sseReconnectBannerVisible && !error && (
          <p role="status" className="mx-auto mb-2 max-w-5xl rounded-card border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
            イベント接続を再試行しています…
          </p>
        )}
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-5xl rounded-card border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
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
        <div ref={progressPanelRef} className="mx-auto max-w-5xl" />
        <div ref={nextActionPanelRef} className="mx-auto max-w-5xl" />
        {pendingSteerVisible && pendingSteer && (
          <p
            role="status"
            aria-live="polite"
            data-pending-steer
            className="mx-auto mb-2 flex max-w-5xl items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-sm text-muted"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-working" aria-hidden="true" />
            <span className="shrink-0">{pendingSteer.accepted ? "次の区切りで割り込みます:" : "割り込みを送信中:"}</span>
            <span className="min-w-0 flex-1 truncate text-text">{pendingSteer.text}</span>
          </p>
        )}
        <div className="mx-auto max-w-5xl">
          <QueuedFollowUpsNotice
            items={queuedFollowUps}
            onRemove={(id) =>
              setQueuedFollowUps((current) => current.filter((item) => item.id !== id))
            }
            sendNowDisabled={queuedSendNowDisabled}
            hint={
              goalLoopVisible
                ? working
                  ? "Goal Loop 中は自動送信されません。即時送信で割り込むか、ループを一時停止・停止すると送信できます"
                  : "Goal Loop 中は自動送信されません。ループを一時停止・停止すると送信できます"
                : undefined
            }
            onSendNow={(id) => {
              if (
                queuedSendNowDisabled || sendingQueuedIdRef.current !== null ||
                shouldBlockSubmitWhileStopRequested(stopRequestedRef.current, working)
              ) return;
              const queued = queuedFollowUps.find((item) => item.id === id);
              if (!queued) return;
              sendingQueuedIdRef.current = id;
              setQueuedFollowUps((current) => current.filter((item) => item.id !== id));
              void submit(queued, true).finally(() => { sendingQueuedIdRef.current = null; });
            }}
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
          className="bot-composer-shell relative mx-auto w-full max-w-5xl rounded-card border border-bot-outline bg-bot-panel px-2 py-1 transition-colors focus-within:border-bot-outline"
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
            onChange: (event) => { setPrompt(event.target.value); if (error) setError(null); },
            onValueChange: (value) => { setPrompt(value); if (error) setError(null); },
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
            placeholder: archived
              ? "アーカイブ済み（読み取り専用）"
              : compacting
                ? "圧縮中です…"
                : pendingTurn && !working
                  ? "送信しています…"
                  : working
                    ? "実行中です。送信するとキューに追加します…"
                    : "続きを指示…（Ctrl+Enter）",
            className: "w-full min-h-11 resize-none bg-transparent py-2.5 text-base leading-6 outline-none placeholder:text-faint",
            disabled: compacting || archived,
          }}
          references={{ skills, agents, prompts: promptPresetReferences }}
          attachmentControl={{
            inputRef: fileInputRef,
            inputDisabled: !canAttachComposerImages({ goalLoopEnabled, compacting, archived }),
            buttonDisabled: !canAttachComposerImages({ goalLoopEnabled, compacting, archived }),
            buttonTitle: "ファイルを添付",
            onFilesSelected: addFiles,
            onTrigger: () => fileInputRef.current?.click(),
            extra: (
              <ProjectFilePicker
                projectId={task?.projectId}
                taskId={task?.id}
                disabled={!canAttachComposerImages({ goalLoopEnabled, compacting, archived })}
                attachments={attachments}
                onPick={(attachment) => setAttachments((current) => [...current, attachment])}
              />
            ),
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
                  const previous = modelValue;
                  if (value === AUTO_MODEL_VALUE) {
                    if (!autoModelEnabled) return;
                    setModelSelection(AUTO_MODEL_VALUE);
                    writeStoredModel(AUTO_MODEL_VALUE);
                    // A running Goal Loop re-resolves Auto before each next turn.
                    if (goalLoopVisible) {
                      void sendJson(`/api/tasks/${taskId}/goal-loop-auto-model`, { enabled: true }, "PUT").catch((err) => {
                        if (modelChangeRef.current !== changeId) return;
                        const fallback = previous === plainTaskModelValue ? "" : previous;
                        setModelSelection(fallback);
                        writeStoredModel(fallback);
                        setError(err instanceof Error ? err.message : "Auto の切替に失敗しました");
                      });
                    }
                    return;
                  }
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
                      // Optimistic selection is only for the in-flight request.
                      // The response may already have fallen back to another route.
                      setModelSelection("");
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
                    const changeId = ++thinkingChangeRef.current;
                    const modelChangeId = modelChangeRef.current;
                    const isCurrent = () => thinkingChangeRef.current === changeId && modelChangeRef.current === modelChangeId;
                    // Order owner writes, not just browser replies. Skip obsolete
                    // queued selections so rapid edits send only the latest effort.
                    thinkingQueueRef.current = thinkingQueueRef.current.catch(() => {}).then(async () => {
                      if (!isCurrent()) return;
                      try {
                        setError(null);
                        const result = await sendJson<{ task: TaskSummary }>(
                          `/api/tasks/${taskId}/thinking`,
                          { thinkingLevel: value },
                        );
                        if (!isCurrent()) return;
                        const level = isThinkingLevel(result.task.thinkingLevel) ? result.task.thinkingLevel : value;
                        // This mutation owns effort only. A late HTTP summary must not
                        // roll back a newer SSE status, route, or task projection.
                        setTask((current) => {
                          if (!isCurrent() || !current || current.id !== taskId || current.thinkingLevel === level) return current;
                          return { ...current, thinkingLevel: level };
                        });
                        writeStoredThinkingLevel(level);
                      } catch (err) {
                        if (!isCurrent()) return;
                        setError(err instanceof Error ? err.message : "思考レベルの切替に失敗しました");
                      }
                    });
                  }}
                />
              )}
              <FastModeSelect
                providerID={modelValue === AUTO_MODEL_VALUE ? null : selectedModel?.providerID}
                disabled={compacting || archived}
                className="h-8 shrink-0"
              />
              {hasMultipleAgentChoices(agents.length, autoAgentEnabled) && (
                <AgentSelect
                  value={agentSelection}
                  agents={agents}
                  autoEnabled={autoAgentEnabled}
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
              id: "continuation",
              label: "継続実行",
              align: "end",
              content: (
                <>
              <GoalLoopToggle
                enabled={goalLoopEnabled}
                disabled={archived || submitting || working || agentChanging || isGoalLoopSessionOwnedStatus(task?.goalLoop?.status)}
                onToggle={() => setGoalLoopEnabled((value) => !value)}
              />
                </>
              ),
            },
          ]}
          action={
            working && (stopRequested || (!prompt.trim() && attachments.length === 0)) ? (
              <Button
                variant="danger"
                size="icon"
                aria-label="停止"
                // Composer Stop aborts the run and ends a live Goal Loop too; the panel offers Pause.
                title={goalLoopVisible ? "停止（Goal Loop も停止します。一時停止はループパネルから）" : "停止"}
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
                aria-label={working ? "キューに追加" : "送信"}
                title={working ? "現在の処理後に送信" : "送信"}
                className={`${COMPOSER_ACTION_BUTTON_CLASS} !bg-accent !text-white hover:!bg-accent/90`}
                busy={submitting}
                disabled={archived || compacting || agentChanging || revertBusy || revertConfirmOpen || shouldBlockSubmitWhileStopRequested(stopRequested, working) || (goalLoopEnabled && working) || (!prompt.trim() && attachments.length === 0)}
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

"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  GitGraph,
  PanelRight,
  Shrink,
  Square,
} from "lucide-react";
import { Composer, type ComposerAttachment } from "@/components/Composer";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { pasteImage } from "@/lib/clipboard-image";
import { GoalLoopPanel } from "@/components/GoalLoopPanel";
import { DiffPane } from "@/components/task/DiffPane";
import { GraphPanel } from "@/components/task/GraphPanel";
import { TodoProgressPanel } from "@/components/task/TodoProgressPanel";
import { ModelSelect } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { AgentSelect } from "@/components/AgentSelect";
import { SubagentPermissionSelect } from "@/components/SubagentPermissionSelect";
import { StatusBadge } from "@/components/StatusBadge";
import { MobileMenuButton } from "@/components/shell/MobileMenuHeader";
import { PartView, WorkingRow } from "@/components/task/PartView";
import { Button, cx } from "@/components/ui";
import { formatTokens, type ContextUsageDto } from "@/lib/context-usage";
import { formatTokensPerSecond } from "@/lib/token-throughput";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import { isNearBottom, nextStickState } from "@/lib/scroll-stick";
import {
  readScrollButtonOpacity,
  subscribeScrollButtonOpacity,
} from "@/lib/scroll-button-opacity";
import { stabilizeUiMessages } from "@/lib/stabilize-messages";
import { isThinkingLevel, thinkingLevelLabel } from "@/lib/thinking-levels";
import {
  readSubagentPermission,
  writeSubagentPermission,
  type SubagentPermission,
} from "@/lib/subagent-permission";
import type {
  GoalLoopDto,
  ModelOption,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TodoDto,
  ThinkingLevel,
  UiMessage,
} from "@/lib/types";

/** Compaction LLM calls routinely exceed the default fetch budget. */
const COMPACT_TIMEOUT_MS = 240_000;

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
}: {
  taskId: string;
  /** 非アクティブタブは hidden mount（CSS で非表示、SSE は維持）。 */
  active?: boolean;
  /** SSE snapshot の status 変化をタブバッジへ報告する（TaskPanesProvider）。 */
  onStatus?: (status: TaskStatus) => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsageDto | undefined>();
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactingLocal, setCompactingLocal] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [goalLoopEnabled, setGoalLoopEnabled] = useState(false);
  const [goalLoopAcceptance, setGoalLoopAcceptance] = useState("");
  const [goalLoopMaxTurns, setGoalLoopMaxTurns] = useState(10);
  const [goalLoopForceFullRun, setGoalLoopForceFullRun] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState("");
  const [subagentPermission, setSubagentPermission] = useState<SubagentPermission>(
    () => readSubagentPermission(),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  // ユーザーメッセージ間をジャンプするナビゲーター（本家 LeafCode と同じ）。
  // 描画済みメッセージ要素と「今どのユーザーメッセージを見ているか」を保持する。
  const messageElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const currentUserIdxRef = useRef(0);
  // onScroll の deps を安定させるため、id 一覧を ref にミラーする（本家と同じ）。
  const userMessageIdsRef = useRef<string[]>([]);
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
  const sidebarNotifyKeyRef = useRef("");

  const applyDetail = useCallback((detail: TaskDetail) => {
    setTask(detail);
    setMessages((prev) => stabilizeUiMessages(prev, detail.messages));
    setContextUsage(detail.contextUsage);
    setIsCompacting(Boolean(detail.isCompacting));
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

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/tasks/${taskId}/events`);
      source.addEventListener("snapshot", (event) => {
        if (closed) return;
        retryCount = 0;
        const payload = JSON.parse((event as MessageEvent).data) as {
          task?: TaskDetail;
          messages?: UiMessage[];
          isStreaming?: boolean;
          isCompacting?: boolean;
          contextUsage?: ContextUsageDto;
          goalLoop?: GoalLoopDto | null;
          todos?: TodoDto[];
          error?: string;
        };
        const snapshotTask = payload.task;
        startTransition(() => {
          if (snapshotTask) {
            setTask((current) => {
              const base = current ?? snapshotTask;
              return {
                ...base,
                ...snapshotTask,
                messages: payload.messages ?? base.messages ?? [],
                isStreaming: payload.isStreaming ?? snapshotTask.isStreaming ?? base.isStreaming,
                isCompacting: payload.isCompacting ?? snapshotTask.isCompacting ?? base.isCompacting,
                contextUsage: payload.contextUsage ?? snapshotTask.contextUsage ?? base.contextUsage,
                goalLoop: payload.goalLoop ?? snapshotTask.goalLoop ?? base.goalLoop,
                todos: payload.todos ?? snapshotTask.todos ?? base.todos,
              };
            });
          }
          if (payload.messages) {
            setMessages((prev) => stabilizeUiMessages(prev, payload.messages!));
          }
          if ("contextUsage" in payload) setContextUsage(payload.contextUsage);
          if ("isCompacting" in payload) setIsCompacting(Boolean(payload.isCompacting));
        });
        if (payload.error) setError(payload.error);
        notifySidebarIfNeeded(snapshotTask);
        const status = snapshotTask?.status;
        if (status) onStatusRef.current?.(status);
      });
      source.addEventListener("error", () => {
        if (closed) return;
        setError((current) => current ?? "イベント接続に失敗しました");
        // Auto-reconnect: close the broken stream and retry with backoff.
        source?.close();
        source = null;
        retryCount += 1;
        const delay = Math.min(1000 * 2 ** (retryCount - 1), 15000);
        retryTimer = setTimeout(connect, delay);
      });
    };

    connect();

    void getJson<{ task: TaskDetail }>(`/api/tasks/${taskId}`).then((result) => {
      if (!closed) applyDetail(result.task);
    });
    void getJson<{ models: ModelOption[] }>("/api/models").then((result) => {
      if (!closed) setModels(result.models);
    });
    void getJson<{ agents: { name: string; enabled: boolean }[] }>("/api/agents").then((result) => {
      if (!closed) {
        const names = result.agents.filter((a) => a.enabled).map((a) => a.name);
        setAgents(names);
        setAgent((current) => (current && names.includes(current) ? current : ""));
      }
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
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
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
    // ビューポート上端に来ているユーザーメッセージを追跡し、前後ジャンプの
    // 基準にする（本家と同じ incremental スキャン）。
    const ids = userMessageIdsRef.current;
    if (ids.length > 0 && messageElsRef.current.size > 0) {
      const line = el.scrollTop + 4;
      let idx = currentUserIdxRef.current;
      const topOf = (i: number) => messageElsRef.current.get(ids[i])?.offsetTop ?? Number.POSITIVE_INFINITY;
      while (idx < ids.length && topOf(idx) < line) idx += 1;
      while (idx > 0 && topOf(idx - 1) >= line) idx -= 1;
      currentUserIdxRef.current = Math.min(Math.max(idx, 0), ids.length - 1);
    }
  }, []);

  // 指定インデックスのユーザーメッセージへスムーズスクロールする。
  // id 一覧は後段で宣言されるため ref 経由で参照する（本家と同じ TDZ 回避）。
  const jumpToUserMessage = useCallback((index: number) => {
    const el = scrollRef.current;
    const targetEl = messageElsRef.current.get(userMessageIdsRef.current[index]);
    if (!el || !targetEl) return;
    const line = el.scrollTop + 4;
    el.scrollTo({
      top: el.scrollTop + targetEl.offsetTop - line,
      behavior: "smooth",
    });
    currentUserIdxRef.current = index;
    stickRef.current = false;
  }, []);

  // 最新位置（タイムライン最下部）へ戻り、追従モードを復帰する。
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    currentUserIdxRef.current = Math.max(0, userMessageIdsRef.current.length - 1);
    stickRef.current = true;
  }, []);

  useEffect(() => {
    stickRef.current = true;
    lastScrollTopRef.current = 0;
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

  async function submit() {
    if ((!prompt.trim() && attachments.length === 0) || submitting || compacting) return;
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
          forceFullRun: goalLoopForceFullRun,
        });
        setGoalLoopEnabled(false);
      } else {
        await sendJson(`/api/tasks/${taskId}/prompt`, {
          prompt,
          images,
          ...(agent ? { agent } : {}),
          subagentPermission,
        });
      }
      setPrompt("");
      setAttachments([]);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  async function goalLoopAction(action: "pause" | "resume" | "stop", maxTurns?: number) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendJson<{ loop: GoalLoopDto | null }>(
        `/api/tasks/${taskId}/goal-loop`,
        { action, ...(maxTurns ? { maxTurns } : {}) },
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

  const modelValue =
    task?.providerID && task.modelID ? `${task.providerID}::${task.modelID}` : models[0]?.value ?? "";
  const selectedModel = models.find((option) => option.value === modelValue);
  const thinkingLevels = useMemo(
    () => selectedModel?.thinkingLevels ?? (["off"] as ThinkingLevel[]),
    [selectedModel],
  );
  const thinkingValue: ThinkingLevel = isThinkingLevel(task?.thinkingLevel)
    ? task.thinkingLevel
    : thinkingLevels.includes("off")
      ? "off"
      : (thinkingLevels[0] ?? "off");
  const working = task?.status === "working" || task?.isStreaming;
  const modelLabels = useMemo(
    () => Object.fromEntries(models.map((option) => [option.value, option.label])),
    [models],
  );
  // 本家 LeafCode と同じく、メタ行の effort はタスクの現在値を表示する。
  const effortLabel =
    thinkingLevels.length > 1 ? thinkingLevelLabel(thinkingValue) : undefined;

  // ナビゲーターのジャンプ対象: ユーザーメッセージの id 一覧（時系列順）。
  const userMessageIds = useMemo(
    () => messages.filter((message) => message.role === "user").map((message) => message.id),
    [messages],
  );
  userMessageIdsRef.current = userMessageIds;

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

  return (
    // min-h-0 flex-1: ペイン section が TaskTabs を持つ場合でも残り高さに収める。
    // h-full だとタブバー分だけはみ出し composer 下端が overflow-hidden で欠ける。
    <div className={cx("flex min-h-0 flex-1 flex-col", !active && "hidden")}>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 pt-[env(safe-area-inset-top)] md:px-4 md:gap-3">
        <MobileMenuButton />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{task?.title ?? "読み込み中…"}</h1>
          {/* Mobile-only compact meta row: the sm:flex row below is hidden
              below sm, so phones would otherwise show no status/context. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-faint sm:hidden">
            {task && <StatusBadge status={working ? "working" : task.status} />}
            {contextUsage && <ContextUsageMeter usage={contextUsage} />}
          </div>
          <div className="mt-0.5 hidden min-w-0 items-center gap-1 text-xs text-faint sm:flex">
            {task && <StatusBadge status={working ? "working" : task.status} />}
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
              title="コミットグラフ"
              aria-label="コミットグラフ"
              aria-pressed={graphOpen}
              disabled={!task}
              className={cx(
                "h-11 w-11 md:h-9 md:w-9",
                graphOpen && "bg-surface-2 text-text",
              )}
              onClick={() => setGraphOpen((value) => !value)}
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
              onClick={() => setDiffOpen((value) => !value)}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
            {working && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => void sendJson(`/api/tasks/${taskId}/abort`, {})}
              >
                <Square className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">停止</span>
              </Button>
            )}
          </div>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-4"
        >
          <div ref={contentRef} className="relative mx-auto flex max-w-5xl flex-col gap-4">
            {messages.map((message) => (
              <div
                key={message.id}
                ref={(el) => {
                  if (el) messageElsRef.current.set(message.id, el);
                  else messageElsRef.current.delete(message.id);
                }}
              >
                <PartView
                  message={message}
                  modelLabel={
                    message.provider && message.model
                      ? modelLabels[`${message.provider}::${message.model}`]
                      : undefined
                  }
                  effort={message.role === "assistant" ? effortLabel : undefined}
                  taskId={taskId}
                />
              </div>
            ))}
            {working && <WorkingRow messages={messages} />}
            {task?.todos && <TodoProgressPanel todos={task.todos} />}
            {messages.length === 0 && (
              <p className="py-12 text-center text-sm text-muted">メッセージはまだありません</p>
            )}
          </div>
        </div>
        {/* ユーザーメッセージ間を移動するナビゲーター（本家 LeafCode と同じ）。
            設定した不透明度で常時表示し、ホバー・フォーカス時だけ不透明になる。 */}
        {userMessageIds.length > 0 && (
          <div className="absolute right-4 bottom-4 z-50 flex flex-col gap-2">
            {(
              [
                ["最初のユーザーメッセージへ", () => jumpToUserMessage(0), <ChevronsUp key="i" className="h-4 w-4" />],
                [
                  "一つ前のユーザーメッセージへ",
                  () => {
                    const target = currentUserIdxRef.current - 1;
                    jumpToUserMessage(target >= 0 ? target : 0);
                  },
                  <ChevronUp key="i" className="h-4 w-4" />,
                ],
                [
                  "一つ後のユーザーメッセージへ",
                  () => {
                    const target = currentUserIdxRef.current + 1;
                    if (target >= userMessageIdsRef.current.length) {
                      jumpToLatest();
                      return;
                    }
                    jumpToUserMessage(target);
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
                  "h-10 w-10 rounded-full border border-border-strong bg-surface shadow-lg",
                  scrollButtonOpacity < 0.95 &&
                    "opacity-[var(--sb-opacity)] hover:opacity-100 focus-visible:opacity-100 active:opacity-100 transition-opacity",
                )}
                style={{ "--sb-opacity": scrollButtonOpacity } as React.CSSProperties}
                onClick={onClick}
              >
                {icon}
              </Button>
            ))}
          </div>
        )}
        {graphOpen && task?.directory && (
          <div className="h-72 shrink-0 border-b border-border lg:h-auto lg:w-80 lg:border-b-0 lg:border-l">
            <GraphPanel directory={task.directory} working={working} />
          </div>
        )}
        {diffOpen && task?.directory && (
          <div className="h-72 shrink-0 border-b border-border lg:h-auto lg:w-80 lg:border-b-0 lg:border-l">
            <DiffPane
              directory={task.directory}
              agent={agent || undefined}
              onMutated={() => notifyTasksChanged()}
            />
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-surface px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
              forceFullRun={goalLoopForceFullRun}
              disabled={submitting || working}
              onAcceptanceChange={setGoalLoopAcceptance}
              onMaxTurnsChange={setGoalLoopMaxTurns}
              onForceFullRunChange={setGoalLoopForceFullRun}
            />
          </div>
        )}
        <Composer
          form={{
            ariaLabel: "フォローアップ",
            onSubmit: (event) => {
              event.preventDefault();
              void submit();
            },
          }}
          className="relative mx-auto max-w-5xl rounded-2xl border border-border bg-bg px-3 py-2 shadow-sm focus-within:border-border-strong focus-within:ring-2 focus-within:ring-primary/20"
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
              <GoalLoopToggle
                enabled={goalLoopEnabled}
                disabled={submitting || working || Boolean(task?.goalLoop && !["completed", "blocked", "stopped"].includes(task.goalLoop.status))}
                onToggle={() => setGoalLoopEnabled((value) => !value)}
              />
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
                  agents={agents}
                  disabled={working || compacting}
                  onChange={setAgent}
                  className="min-w-0 max-w-[8rem] sm:max-w-40"
                />
              )}
              <SubagentPermissionSelect
                value={subagentPermission}
                disabled={working || compacting}
                onChange={(mode) => {
                  setSubagentPermission(mode);
                  writeSubagentPermission(mode);
                }}
                className="h-8 shrink-0"
              />
            </>
          }
          action={
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
          }
        />
      </div>
    </div>
  );
}

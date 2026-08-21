"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  Minus,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cx, formatMessageTime } from "@/components/ui";
import { formatTokens } from "@/lib/context-usage";
import { formatTokensPerSecond } from "@/lib/token-throughput";
import { toolInputFields, toolLabel, toolSummary } from "@/lib/tool-labels";
import { subagentAgentNames, useSubagentRuns } from "@/components/task/use-subagent-runs";
import type { SubagentRunDto, UiMessage, UiPart } from "@/lib/types";

const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="md text-sm">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
});

export function toolIcon(tool: string) {
  const t = tool.toLowerCase();
  if (t.includes("bash") || t.includes("shell")) return Terminal;
  if (t.includes("todo")) return ListTodo;
  if (t.includes("edit") || t.includes("write") || t.includes("patch")) return FilePen;
  if (t.includes("read")) return FileText;
  if (t.includes("glob") || t.includes("grep") || t.includes("find") || t === "ls") return Search;
  if (t.includes("web") || t.includes("fetch")) return Globe;
  if (t.includes("subagent") || t.includes("agent") || t === "task") return Bot;
  return Wrench;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** 実行中は 500ms 毎に、終了後は固定値で経過時間を返す。 */
function useElapsedMs(startedAtMs: number | undefined, endedAtMs: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAtMs !== undefined) {
      setNow(endedAtMs);
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [endedAtMs]);
  if (startedAtMs === undefined) return 0;
  return Math.max(0, now - startedAtMs);
}

const SUBAGENT_STATUS_LABEL: Record<SubagentRunDto["status"], string> = {
  running: "実行中",
  completed: "完了",
  error: "失敗",
  stale: "応答なし",
};

/** 子タイムライン。実行中は末尾に追従する（上へスクロールしたら追従しない）。 */
function NestedRunTimeline({ run }: { run: SubagentRunDto }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    if (run.status !== "running" || !stickRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.messages, run.status, run.currentTool]);
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="max-h-72 space-y-3 overflow-y-auto border-t border-border px-3 py-3"
    >
      {run.truncated && <p className="text-[11px] text-faint">（長いため先頭は省略）</p>}
      {run.messages.length === 0 ? (
        <p className="text-[11px] text-faint">
          {run.status === "running" ? "作業を開始しています…" : "タイムラインはまだありません"}
        </p>
      ) : (
        run.messages.map((message) => <PartView key={message.id} message={message} nested />)
      )}
    </div>
  );
}

/**
 * 子エージェント（pi-subagents）のライブタイムライン。本家 LeafCode の
 * NestedAgentPanel 相当。子の transcript アーティファクトを BFF 経由で読む。
 */
function NestedAgentPanel({
  taskId,
  part,
  live,
}: {
  taskId: string;
  part: Extract<UiPart, { type: "tool" }>;
  live: boolean;
}) {
  const runIds = part.state.subagentRunIds ?? [];
  const agentNames = useMemo(() => subagentAgentNames(part.state.input), [part.state.input]);
  // 開始時刻も run id も無い（古いセッション）ときは無関係な実行を拾わない。
  const sinceMs =
    part.state.startedAtMs !== undefined ? part.state.startedAtMs - 5_000 : undefined;
  const enabled = runIds.length > 0 || sinceMs !== undefined;
  const { runs, error, loading } = useSubagentRuns({
    taskId,
    enabled,
    live,
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    runIds,
    agentNames,
  });

  if (!enabled) return null;
  if (runs.length === 0) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-faint">
        {(live || loading) && <Loader2 className="h-3 w-3 animate-spin" />}
        {error ?? (live ? "サブエージェント起動を待機中…" : "子エージェントの記録は見つかりませんでした")}
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-surface">
      {error && <p className="px-3 pt-2 text-[11px] text-danger">{error}</p>}
      {runs.map((run) => (
        <section key={run.runId} className="border-b border-border/60 last:border-b-0">
          <div className="flex items-center gap-2 px-3 py-2">
            {run.status === "running" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-working" />
            ) : run.status === "error" ? (
              <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
            ) : run.status === "stale" ? (
              <Minus className="h-3.5 w-3.5 shrink-0 text-muted" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-success/70" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
              {run.agent}
              {run.index !== undefined && run.index > 0 ? ` #${run.index}` : ""}
            </span>
            {run.currentTool && (
              <span className="hidden max-w-40 truncate text-[10px] text-working sm:inline">
                {toolLabel(run.currentTool)}
              </span>
            )}
            <span className="shrink-0 text-[10px] text-faint">
              {SUBAGENT_STATUS_LABEL[run.status]}
            </span>
          </div>
          <NestedRunTimeline run={run} />
        </section>
      ))}
    </div>
  );
}

function ToolCard({
  part,
  taskId,
  nested = false,
}: {
  part: Extract<UiPart, { type: "tool" }>;
  taskId?: string;
  nested?: boolean;
}) {
  const state = part.state;
  const status = state.status;
  const tool = part.tool;
  const active = status === "running" || status === "pending";
  const isError = status === "error";
  const isCancelled = status === "cancelled";
  // サブエージェントは入れ子タイムラインを見せたいので実行中は開いておく。
  const isSubagent = !nested && Boolean(taskId) && /subagent|^task$/i.test(tool);
  // 本家 LeafCode と同じ: 通常は畳んだまま、失敗・中断・サブエージェント実行中は開く。
  const [open, setOpen] = useState(isError || isCancelled || (isSubagent && active));
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (isError || isCancelled) setOpen(true);
  }, [isError, isCancelled]);
  useEffect(() => {
    if (!isSubagent) return;
    if (active) {
      if (!wasActiveRef.current) setOpen(true);
      wasActiveRef.current = true;
      return;
    }
    // 実行が終わったタイミングで一度だけ結果を見せる（本家と同じ挙動）。
    if (wasActiveRef.current) {
      setOpen(true);
      wasActiveRef.current = false;
    }
  }, [isSubagent, active]);
  const elapsedMs = useElapsedMs(state.startedAtMs, state.endedAtMs);
  const Icon = toolIcon(tool);
  const summary = toolSummary(tool, state);
  const fields = useMemo(() => toolInputFields(tool, state.input), [tool, state.input]);
  const raw = isCancelled ? "" : state.error || state.output || "";
  // 巨大出力で Markdown / DOM が固まらないよう頭を切る。
  const output = raw.length > 20_000 ? `${raw.slice(0, 20_000)}\n…（以降省略）` : raw;
  const preview = isCancelled
    ? "中断されました"
    : output
      ? `${isError ? "エラー: " : ""}${output.replace(/\s+/g, " ").slice(0, isError ? 80 : 100)}`
      : "";
  const hasDetail = fields.length > 0 || Boolean(output) || isCancelled || isSubagent;
  // 実行中は自動で開く（上の effect）が、畳めば隠せる。
  const showNested = isSubagent && open;
  // シェル出力は Markdown にすると空白・整列が壊れるので等幅のまま出す。
  const monoOutput = isError || /bash|shell/i.test(tool);

  return (
    <div
      className={cx(
        "overflow-hidden rounded-xl border text-sm",
        isError ? "border-danger/40" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen((value) => !value)}
        aria-expanded={hasDetail ? open : undefined}
        className={cx(
          "flex w-full items-center gap-2.5 bg-surface-2 px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary focus-visible:outline-none",
          hasDetail && "cursor-pointer hover:bg-surface-3",
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-muted">{toolLabel(tool)}</span>
            <span className="min-w-0 truncate text-xs text-text" title={summary}>
              {summary}
            </span>
          </div>
          {preview && !open && (
            <p className="mt-0.5 truncate text-[11px] text-faint">{preview}</p>
          )}
          {active && state.startedAtMs !== undefined && (
            <p className="mt-0.5 text-[11px] text-faint">{formatElapsed(elapsedMs)}</p>
          )}
        </div>
        {!active && state.endedAtMs !== undefined && (
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums text-faint"
            title={`実行時間 ${formatElapsed(elapsedMs)}`}
          >
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <span className="sr-only">
          {active ? "実行中" : isError ? "エラー" : isCancelled ? "中断" : "完了"}
        </span>
        {active ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-working" />
        ) : isError ? (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
        ) : isCancelled ? (
          <Minus className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-success/70" />
        )}
        {hasDetail && (
          <ChevronRight
            className={cx(
              "h-3.5 w-3.5 shrink-0 text-faint transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {showNested && taskId && <NestedAgentPanel taskId={taskId} part={part} live={active} />}
      {open && (
        <div className="max-h-80 space-y-3 overflow-x-hidden overflow-y-auto border-t border-border bg-surface px-3 py-3">
          {fields.length > 0 && (
            <dl className="space-y-2">
              {fields.map((field) => (
                <div key={`${field.label}-${field.value}`}>
                  <dt className="text-[11px] font-medium text-faint">{field.label}</dt>
                  <dd className="mt-0.5 break-all whitespace-pre-wrap text-xs text-muted">
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {isCancelled && <p className="text-sm text-muted">中断されました</p>}
          {output && (
            <div
              className={cx(
                "rounded-lg px-3 py-2 text-sm",
                isError ? "bg-danger-bg text-danger" : "bg-surface-2 text-text/90",
              )}
            >
              {monoOutput ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">{output}</pre>
              ) : (
                <MarkdownBody text={output} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CompactionNotice({ message }: { message: UiMessage }) {
  const summary = message.parts.find((part) => part.type === "text");
  const before =
    typeof message.tokensBefore === "number" ? formatTokens(message.tokensBefore) : null;
  return (
    <details className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
      <summary className="cursor-pointer select-none font-medium text-text">
        コンテキストを圧縮しました
        {before ? `（圧縮前 ${before}）` : ""}
        <span className="ml-2 font-normal text-faint">{formatMessageTime(message.createdAt)}</span>
      </summary>
      {summary && summary.type === "text" && (
        <div className="mt-2 border-t border-border pt-2">
          <MarkdownBody text={summary.text} />
        </div>
      )}
    </details>
  );
}

/** 本家 LeafCode の MessageMetaHeader と同じ「アイコン · 値 · 値」1 行。 */
function MessageMetaHeader({
  message,
  modelLabel,
  effort,
}: {
  message: UiMessage;
  modelLabel?: string;
  effort?: string;
}) {
  const model = modelLabel?.trim() || message.model?.trim() || "";
  const tokens =
    typeof message.outputTokens === "number" && message.outputTokens > 0
      ? `${formatTokens(message.outputTokens)} tok`
      : "";
  const rate =
    typeof message.tokensPerSecond === "number"
      ? formatTokensPerSecond(message.tokensPerSecond)
      : "";
  const fields = [
    model ? { key: "model", text: model } : null,
    effort?.trim() ? { key: "effort", text: effort.trim() } : null,
    { key: "time", text: formatMessageTime(message.createdAt) },
    tokens ? { key: "tokens", text: tokens } : null,
    rate ? { key: "rate", text: rate } : null,
  ].filter((field): field is { key: string; text: string } => Boolean(field?.text));

  return (
    <div
      aria-label="応答メタデータ"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted"
    >
      {/* 合成メッセージ（bash 実行など）はプロバイダを持たないので汎用アイコンを出さない。 */}
      {message.provider && <ProviderIcon providerID={message.provider} size={14} />}
      {fields.map((field, index) => (
        <Fragment key={field.key}>
          {index > 0 && <span aria-hidden="true">·</span>}
          <span
            className={cx(
              field.key === "model" ? "min-w-0 max-w-64 truncate" : "shrink-0",
              field.key === "rate" && "tabular-nums",
            )}
            title={
              field.key === "rate" && message.tokensPerSecondDecode
                ? "decode tok/s（最初のトークン以降、TTFT 除外）"
                : field.key === "rate"
                  ? "end-to-end tok/s（TTFT 含む）"
                  : field.key === "model"
                    ? field.text
                    : undefined
            }
          >
            {field.text}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** タイムライン末尾の実行中インジケータ（本家の WorkingProgressPanel 相当の 1 行版）。 */
export function WorkingRow({ messages }: { messages: UiMessage[] }) {
  const running = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "assistant") continue;
      for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = message.parts[partIndex];
        if (part?.type !== "tool") continue;
        if (part.state.status === "running" || part.state.status === "pending") return part;
      }
      break;
    }
    return null;
  }, [messages]);
  const startedAtMs =
    running?.state.startedAtMs ?? messages[messages.length - 1]?.createdAt ?? undefined;
  const elapsedMs = useElapsedMs(startedAtMs, undefined);
  const headline = running
    ? `${toolLabel(running.tool)} ${toolSummary(running.tool, running.state)}`
    : "作業中…";
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-working" />
      <span className="min-w-0 flex-1 truncate">{headline}</span>
      {startedAtMs !== undefined && (
        <span
          className={cx(
            "shrink-0 font-mono text-xs tabular-nums",
            elapsedMs >= 60_000 ? "text-danger" : elapsedMs >= 30_000 ? "text-warning" : "text-faint",
          )}
        >
          {formatElapsed(elapsedMs)}
        </span>
      )}
    </div>
  );
}

export const PartView = memo(
  function PartView({
    message,
    modelLabel,
    effort,
    taskId,
    nested = false,
  }: {
    message: UiMessage;
    modelLabel?: string;
    effort?: string;
    /** サブエージェント入れ子パネルの取得に使う（トップレベルのみ）。 */
    taskId?: string;
    /** 入れ子タイムライン内での描画（さらに入れ子にはしない）。 */
    nested?: boolean;
  }) {
    if (message.role === "compaction") {
      return <CompactionNotice message={message} />;
    }

    const isUser = message.role === "user";
    return (
      <article className="flex min-w-0 flex-col gap-2">
        <div className={cx("flex min-w-0", isUser ? "justify-end" : "justify-start")}>
          {isUser ? (
            <span className="text-[10px] text-faint">{formatMessageTime(message.createdAt)}</span>
          ) : (
            <MessageMetaHeader message={message} modelLabel={modelLabel} effort={effort} />
          )}
        </div>
        {message.parts.map((part) => {
          if (part.type === "text") {
            return isUser ? (
              <div
                key={part.id}
                className="ml-auto min-w-0 max-w-[88%] rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-[0.925rem] whitespace-pre-wrap break-words"
              >
                {part.text}
              </div>
            ) : (
              <MarkdownBody key={part.id} text={part.text} />
            );
          }
          if (part.type === "thinking") {
            return (
              <div key={part.id} className="flex min-w-0 items-start gap-2">
                <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-faint">
                  <Brain className="h-3.5 w-3.5" />
                  思考
                </span>
                <div className="min-w-0 flex-1 text-sm whitespace-pre-wrap break-words text-muted">
                  {part.text}
                </div>
              </div>
            );
          }
          if (part.type === "image") {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={part.id}
                src={part.url}
                alt={part.filename ?? "画像"}
                className={cx(
                  "max-h-64 rounded-xl border border-border",
                  isUser && "ml-auto",
                )}
              />
            );
          }
          return <ToolCard key={part.id} part={part} taskId={taskId} nested={nested} />;
        })}
        {message.error && (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {message.error}
          </p>
        )}
      </article>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.modelLabel === next.modelLabel &&
    prev.effort === next.effort &&
    prev.taskId === next.taskId &&
    prev.nested === next.nested,
);

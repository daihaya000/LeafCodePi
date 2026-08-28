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
  RotateCcw,
  Search,
  Terminal,
  UserRound,
  Wrench,
} from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ReferenceHighlight, type ReferenceHighlightReferences } from "@/components/ReferenceHighlight";
import { Button, cx, formatMessageTime } from "@/components/ui";
import { formatTokens } from "@/lib/context-usage";
import { formatTokensPerSecond } from "@/lib/token-throughput";
import { clampScrollTop, isNearBottom, nextStickState } from "@/lib/scroll-stick";
import {
  parseStructuredResult,
  type StructuredResult,
  type StructuredResultStatus,
} from "@/lib/structured-result";
import { isSkillRead, toolInputFields, toolLabel, toolSummary } from "@/lib/tool-labels";
import { subagentAgentNames, useSubagentRuns } from "@/components/task/use-subagent-runs";
import {
  saveReasoningTranslationOverride,
  useReasoningTranslation,
} from "@/lib/reasoning-translation";
import type { SubagentRunDto, UiDiagnostic, UiMessage, UiPart } from "@/lib/types";

const structuredResultLabels: Record<StructuredResultStatus, string> = {
  progress: "進行中",
  completed: "完了",
  verified_completed: "検証済み",
  blocked: "要対応",
};

function structuredResultBadgeClass(status: StructuredResultStatus): string {
  if (status === "completed" || status === "verified_completed") {
    return "bg-success/15 text-success";
  }
  if (status === "blocked") return "bg-warning-bg text-warning";
  return "bg-primary/15 text-primary";
}

function StructuredResultCard({ result }: { result: StructuredResult }) {
  return (
    <section
      aria-label="実行結果"
      className="rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <span
          className={cx(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            structuredResultBadgeClass(result.status),
          )}
        >
          {structuredResultLabels[result.status]}
        </span>
        <span className="text-[11px] text-faint">構造化された実行結果</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text">{result.summary}</p>
      {result.next && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[11px] font-medium text-faint">次のステップ</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted">{result.next}</p>
        </div>
      )}
      {result.evidence && (
        <details className="mt-2 rounded-lg bg-surface-2 px-2.5 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-muted">
            証拠・確認結果
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted">{result.evidence}</p>
        </details>
      )}
    </section>
  );
}

function DiagnosticDetails({ diagnostics }: { diagnostics: UiDiagnostic[] }) {
  return (
    <details className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
      <summary className="cursor-pointer select-none font-medium text-muted">
        診断情報 ({diagnostics.length})
      </summary>
      <div className="mt-2 space-y-2 text-faint">
        {diagnostics.map((diagnostic, index) => (
          <div
            key={`${diagnostic.type}-${diagnostic.timestamp ?? index}`}
            className="border-t border-border pt-2 first:border-0 first:pt-0"
          >
            <p className="font-medium text-muted">{diagnostic.type}</p>
            {diagnostic.error && (
              <p className="mt-1 whitespace-pre-wrap break-words">
                {diagnostic.error.name ? `${diagnostic.error.name}: ` : ""}
                {diagnostic.error.message}
                {diagnostic.error.code !== undefined ? ` (code: ${diagnostic.error.code})` : ""}
              </p>
            )}
            {diagnostic.details?.configuredTransport && (
              <p className="mt-1">transport: {diagnostic.details.configuredTransport}</p>
            )}
            {diagnostic.details?.fallbackTransport && (
              <p>fallback: {diagnostic.details.fallbackTransport}</p>
            )}
            {diagnostic.details?.phase && <p>phase: {diagnostic.details.phase}</p>}
            {diagnostic.details?.eventsEmitted !== undefined && (
              <p>events emitted: {diagnostic.details.eventsEmitted ? "yes" : "no"}</p>
            )}
            {diagnostic.details?.requestBytes !== undefined && (
              <p>request bytes: {diagnostic.details.requestBytes.toLocaleString()}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  const structuredResult = parseStructuredResult(text);
  if (structuredResult) return <StructuredResultCard result={structuredResult} />;
  return (
    <div className="md text-sm">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
});

type SkillInvocation = {
  name: string;
  userMessage?: string;
};

/** Pi expands /skill:name into this persisted user-message envelope. */
function parseSkillInvocation(text: string): SkillInvocation | null {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]+))?$/,
  );
  if (!match) return null;
  return {
    name: match[1]!,
    userMessage: match[4]?.trim() || undefined,
  };
}

function UserTextPart({
  text,
  references,
}: {
  text: string;
  references?: ReferenceHighlightReferences;
}) {
  const invocation = parseSkillInvocation(text);
  const renderText = (value: string) =>
    references ? <ReferenceHighlight text={value} references={references} /> : value;

  if (!invocation) {
    return (
      <div className="ml-auto min-w-0 max-w-[88%] rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-[0.925rem] whitespace-pre-wrap break-words">
        {renderText(text)}
      </div>
    );
  }

  const skillReference: ReferenceHighlightReferences = {
    skills: [{ name: invocation.name }],
    agents: [],
  };
  return (
    <div className="ml-auto min-w-0 max-w-[88%] rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-[0.925rem] whitespace-pre-wrap break-words">
      <ReferenceHighlight text={`/skill:${invocation.name}`} references={skillReference} />
      {invocation.userMessage && (
        <>{" "}{renderText(invocation.userMessage)}</>
      )}
    </div>
  );
}

export function toolIcon(tool: string, input?: Record<string, unknown>) {
  const t = tool.toLowerCase();
  if (isSkillRead(tool, input)) return Wrench;
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

const SUBAGENT_PROMPT_PLACEHOLDER = "[prompt redacted]; live Prompt Audit only.";

function textPartsOf(message: UiMessage): string {
  return message.parts
    .filter((part): part is Extract<UiPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isSubagentPromptPlaceholder(message: UiMessage): boolean {
  return message.role === "user" && textPartsOf(message) === SUBAGENT_PROMPT_PLACEHOLDER;
}

function NestedUserMetaHeader({
  run,
  message,
}: {
  run: SubagentRunDto;
  message: UiMessage;
}) {
  return (
    <div
      aria-label="サブエージェントメタデータ"
      className="flex min-w-0 items-center gap-1.5 text-[11px] whitespace-nowrap text-muted"
    >
      <Bot className="h-3.5 w-3.5 shrink-0 text-faint" />
      <span className="min-w-0 truncate">{run.agent}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{formatMessageTime(message.createdAt)}</span>
    </div>
  );
}

/** 子タイムライン。実行中は末尾に追従する（上へスクロールしたら追従しない）。 */
function NestedRunTimeline({ run }: { run: SubagentRunDto }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const visibleMessages = useMemo(
    () => run.messages.filter((message) => !isSubagentPromptPlaceholder(message)),
    [run.messages],
  );
  useEffect(() => {
    if (run.status !== "running" || !stickRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight);
  }, [visibleMessages, run.status, run.currentTool]);
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
      {visibleMessages.length === 0 ? (
        <p className="text-[11px] text-faint">
          {run.status === "running" ? "作業を開始しています…" : "タイムラインはまだありません"}
        </p>
      ) : (
        visibleMessages.map((message) => (
          <div key={message.id} className="flex min-w-0 flex-col gap-2">
            {message.role === "user" && <NestedUserMetaHeader run={run} message={message} />}
            <PartView
              message={message}
              modelLabel={run.model}
              agent={run.agent}
              nested
            />
          </div>
        ))
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
            {run.model && (
              <span className="hidden min-w-0 items-center gap-1 text-[10px] text-faint sm:flex">
                <ProviderIcon providerID={run.provider} size={12} />
                <span className="truncate">{run.model}</span>
              </span>
            )}
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
  const isShell = /bash|shell/i.test(tool);
  // サブエージェントは入れ子タイムラインを見せたいので実行中は開いておく。
  const isSubagent = !nested && Boolean(taskId) && /subagent|^task$/i.test(tool);
  // 通常は畳んだまま、失敗・中断・シェル実行中・サブエージェント実行中は開く。
  const [open, setOpen] = useState(
    isError || isCancelled || (isShell && active) || (isSubagent && active),
  );
  const wasActiveRef = useRef(false);
  const wasShellActiveRef = useRef(isShell && active);
  const logScrollerRef = useRef<HTMLDivElement | null>(null);
  const logStickRef = useRef(true);
  const lastLogScrollTopRef = useRef(0);
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
  useEffect(() => {
    if (isShell && active && !wasShellActiveRef.current) setOpen(true);
    wasShellActiveRef.current = isShell && active;
  }, [isShell, active]);
  const elapsedMs = useElapsedMs(state.startedAtMs, state.endedAtMs);
  const Icon = toolIcon(tool, state.input);
  const summary = toolSummary(tool, state);
  const fields = useMemo(() => toolInputFields(tool, state.input), [tool, state.input]);
  const raw = isCancelled ? "" : state.error || state.output || "";
  // 巨大出力で Markdown / DOM が固まらないよう頭を切る。
  const output = raw.length > 20_000 ? `${raw.slice(0, 20_000)}\n…（以降省略）` : raw;
  useEffect(() => {
    if (!isShell || !open || !output || !logStickRef.current) return;
    const el = logScrollerRef.current;
    if (!el) return;
    el.scrollTop = clampScrollTop(el.scrollHeight, el.clientHeight, el.scrollHeight);
    lastLogScrollTopRef.current = el.scrollTop;
  }, [isShell, open, output]);
  const preview = isCancelled
    ? "中断されました"
    : output
      ? `${isError ? "エラー: " : ""}${output.replace(/\s+/g, " ").slice(0, isError ? 80 : 100)}`
      : "";
  const hasDetail = fields.length > 0 || Boolean(output) || isCancelled || isSubagent;
  // 実行中は自動で開く（上の effect）が、畳めば隠せる。
  const showNested = isSubagent && open;
  // シェル出力は Markdown にすると空白・整列が壊れるので等幅のまま出す。
  const monoOutput = isError || isShell;

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
            <span className="shrink-0 text-xs font-medium text-muted">{toolLabel(tool, state.input)}</span>
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
        <div
          ref={isShell ? logScrollerRef : undefined}
          onScroll={
            isShell
              ? (event) => {
                  const el = event.currentTarget;
                  const atBottom = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
                  const previousTop = lastLogScrollTopRef.current;
                  lastLogScrollTopRef.current = el.scrollTop;
                  logStickRef.current = nextStickState(
                    logStickRef.current,
                    el.scrollTop,
                    previousTop,
                    atBottom,
                  );
                }
              : undefined
          }
          className="max-h-80 space-y-3 overflow-x-hidden overflow-y-auto border-t border-border bg-surface px-3 py-3"
        >
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
          {isShell && active && !output && (
            <p className="text-[11px] text-faint">ログを待機中…</p>
          )}
          {output && (
            <div
              className={cx(
                "rounded-lg border px-3 py-2 text-sm",
                isShell
                  ? "border-terminal-border bg-terminal-bg text-terminal-text"
                  : isError
                    ? "border-danger/30 bg-danger-bg text-danger"
                    : "border-transparent bg-surface-2 text-text/90",
              )}
            >
              {isShell && (
                <p className="mb-1.5 text-[10px] font-medium tracking-wide text-terminal-muted">ログ</p>
              )}
              {monoOutput ? (
                <pre
                  className={cx(
                    "whitespace-pre-wrap break-words font-mono text-xs",
                    isShell && (isError ? "text-danger" : "text-terminal-text"),
                  )}
                >
                  {output}
                </pre>
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
  agent,
  accountLabel,
}: {
  message: UiMessage;
  modelLabel?: string;
  effort?: string;
  /** 本家同様、担当エージェント名をバッジ表示（セッションのメインペルソナ）。 */
  agent?: string;
  /** タスクに紐づく利用アカウントの表示名。 */
  accountLabel?: string;
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
  // 応答全体の所要時間（直前レコードからの差分）。本家も同じ近似で
  // 「thinking 秒」として表示している。
  const thinking =
    typeof message.responseDurationMs === "number" && message.responseDurationMs > 0
      ? formatElapsed(message.responseDurationMs)
      : "";
  const fields = [
    model ? { key: "model", text: model } : null,
    effort?.trim() ? { key: "effort", text: effort.trim() } : null,
    agent?.trim() ? { key: "agent", text: agent.trim() } : null,
    accountLabel?.trim() ? { key: "account", text: accountLabel.trim() } : null,
    { key: "time", text: formatMessageTime(message.createdAt) },
    tokens ? { key: "tokens", text: tokens } : null,
    rate ? { key: "rate", text: rate } : null,
    thinking ? { key: "thinking", text: thinking } : null,
  ].filter((field): field is { key: string; text: string } => Boolean(field?.text));

  return (
    <div
      aria-label="応答メタデータ"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted"
    >
      {/* 合成メッセージ（シェル実行など）はプロバイダを持たないので汎用アイコンを出さない。 */}
      {message.provider && <ProviderIcon providerID={message.provider} size={14} />}
      {fields.map((field, index) => (
        <Fragment key={field.key}>
          {index > 0 && <span aria-hidden="true">·</span>}
          <span
            className={cx(
              field.key === "model" || field.key === "account"
                ? "min-w-0 max-w-64 truncate"
                : "shrink-0",
              field.key === "rate" && "tabular-nums",
            )}
            title={
              field.key === "rate" && message.tokensPerSecondDecode
                ? "decode tok/s（最初のトークン以降、TTFT 除外）"
                : field.key === "rate"
                  ? "end-to-end tok/s（TTFT 含む）"
                  : field.key === "thinking"
                    ? "応答時間（思考＋生成を含む目安）"
                    : field.key === "model"
                      ? field.text
                      : undefined
            }
          >
            {field.key === "account" && (
              <UserRound className="mr-0.5 inline h-3 w-3 align-[-1px]" aria-hidden />
            )}
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
    ? `${toolLabel(running.tool, running.state.input)} ${toolSummary(running.tool, running.state)}`
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

/** 本家 LeafCode と同じ: 思考要約の太字マーカーを落としてから翻訳に渡す。 */
function stripReasoningMarkdown(text: string): string {
  return text.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
}

const ReasoningView = memo(function ReasoningView({ text }: { text: string }) {
  const shownText = stripReasoningMarkdown(text);
  const { mode, translated } = useReasoningTranslation(shownText);
  const [showOriginal, setShowOriginal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setEditing(false);
    setSaveError(null);
  }, [shownText]);

  useEffect(() => {
    setShowOriginal(false);
  }, [mode, shownText, translated]);

  if (!shownText.trim()) return null;
  const showTranslation = mode !== "original" && Boolean(translated);

  const closeEditor = () => {
    setEditing(false);
    setSaveError(null);
    window.setTimeout(() => editButtonRef.current?.focus(), 0);
  };

  const saveCorrection = async () => {
    if (saving || !draft.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveReasoningTranslationOverride(shownText, draft);
      closeEditor();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "修正訳を保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="group/reasoning relative flex min-w-0 items-start gap-2">
      <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-faint">
        <Brain className="h-3.5 w-3.5" />
        思考
      </span>
      <div className="min-w-0 flex-1 pr-10 text-sm font-normal text-muted">
        {showTranslation ? (
          mode === "bilingual" ? (
            <>
              <div className="whitespace-pre-wrap break-words">{translated}</div>
              <div className="mt-1.5 border-t border-border/60 pt-1.5 text-xs text-faint">
                <div className="whitespace-pre-wrap break-words">{shownText}</div>
              </div>
            </>
          ) : (
            // Keep the original text in the grid's intrinsic height while the
            // translated text is shown. Most Japanese translations are
            // shorter, so this prevents async translation from shrinking the
            // timeline and shifting the user's scroll position.
            <div className="grid">
              <div
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 whitespace-pre-wrap break-words"
              >
                {shownText}
              </div>
              <button
                type="button"
                className="col-start-1 row-start-1 block w-full cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-normal text-muted focus-visible:rounded focus-visible:ring-2 focus-visible:ring-primary/40 whitespace-pre-wrap break-words"
                title={showOriginal ? "クリックして翻訳を表示" : shownText}
                aria-label={showOriginal ? "翻訳を表示" : "原文を表示"}
                aria-pressed={showOriginal}
                onClick={() => setShowOriginal((value) => !value)}
              >
                {showOriginal ? shownText : translated}
              </button>
            </div>
          )
        ) : (
          <div className="whitespace-pre-wrap break-words">{shownText}</div>
        )}
        {showTranslation && !editing && (
          <Button
            ref={editButtonRef}
            variant="ghost"
            size="icon"
            title="訳を修正"
            aria-label="訳を修正"
            onClick={() => {
              setDraft(translated ?? "");
              setSaveError(null);
              setEditing(true);
            }}
            className="absolute right-0 top-0 z-10 h-9 w-9 bg-surface/90 opacity-60 after:absolute after:-inset-1 hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/reasoning:opacity-100"
          >
            <FilePen className="h-3.5 w-3.5" />
          </Button>
        )}
        {showTranslation && editing && (
          <form
            className="mt-3 rounded-lg border border-border bg-surface-2 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCorrection();
            }}
          >
            <p className="text-[11px] font-medium text-faint">原文</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-faint">{shownText}</p>
            <label className="mt-3 block text-[11px] font-medium text-muted">
              修正後の翻訳
              <textarea
                autoFocus
                value={draft}
                maxLength={16_000}
                onChange={(event) => setDraft(event.target.value)}
                className="mt-1 min-h-24 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>
            {saveError && (
              <p role="alert" className="mt-2 text-xs text-danger">{saveError}</p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-11 sm:h-8"
                disabled={saving}
                onClick={closeEditor}
              >
                キャンセル
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="h-11 sm:h-8"
                busy={saving}
                disabled={!draft.trim()}
                type="submit"
              >
                <Check className="h-3.5 w-3.5" />
                保存
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
});

export const PartView = memo(
  function PartView({
    message,
    modelLabel,
    effort,
    agent,
    accountLabel,
    taskId,
    nested = false,
    onRevert,
    references,
  }: {
    message: UiMessage;
    modelLabel?: string;
    effort?: string;
    agent?: string;
    accountLabel?: string;
    /** サブエージェント入れ子パネルの取得に使う（トップレベルのみ）。 */
    taskId?: string;
    /** 入れ子タイムライン内での描画（さらに入れ子にはしない）。 */
    nested?: boolean;
    /** ユーザーメッセージの「入力欄に戻す」コールバック（トップレベル user のみ）。 */
    onRevert?: (message: UiMessage) => void;
    /** 送信済みメッセージ内でハイライトする既知のスキル・エージェント。 */
    references?: ReferenceHighlightReferences;
  }) {
    if (message.role === "compaction") {
      return <CompactionNotice message={message} />;
    }

    const isUser = message.role === "user";
    return (
      <article className="flex min-w-0 flex-col gap-2">
        <div className={cx("flex min-w-0", isUser ? "justify-end" : "justify-start")}>
          {isUser ? (
            !nested && (
              <span className="text-[10px] text-faint">{formatMessageTime(message.createdAt)}</span>
            )
          ) : (
            <MessageMetaHeader
              message={message}
              modelLabel={modelLabel}
              effort={effort}
              agent={agent}
              accountLabel={accountLabel}
            />
          )}
        </div>
        {message.parts.map((part) => {
          if (part.type === "text") {
            return isUser ? (
              <UserTextPart key={part.id} text={part.text} references={references} />
            ) : (
              <MarkdownBody key={part.id} text={part.text} />
            );
          }
          if (part.type === "thinking") {
            return <ReasoningView key={part.id} text={part.text} />;
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
        {isUser && !nested && onRevert && (
          <button
            type="button"
            title="このコメントを入力欄に戻して巻き戻す"
            onClick={() => onRevert(message)}
            className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-3 active:text-text disabled:opacity-40 touch-manipulation"
          >
            <RotateCcw className="h-3 w-3" />
            入力欄に戻す
          </button>
        )}
        {message.error && (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {message.error}
          </p>
        )}
        {message.diagnostics && message.diagnostics.length > 0 && (
          <DiagnosticDetails diagnostics={message.diagnostics} />
        )}
      </article>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.modelLabel === next.modelLabel &&
    prev.effort === next.effort &&
    prev.agent === next.agent &&
    prev.accountLabel === next.accountLabel &&
    prev.taskId === next.taskId &&
    prev.nested === next.nested &&
    prev.onRevert === next.onRevert,
);

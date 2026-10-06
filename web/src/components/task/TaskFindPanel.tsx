"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bookmark, Bot, ChevronDown, ChevronUp, Loader2, Search, Trash2, UserRound, X } from "lucide-react";
import { Button, cx, formatMessageTime } from "@/components/ui";
import type { TaskFind } from "@/components/task/use-task-find";
import { getJson } from "@/lib/client";
import { isImeComposingEvent } from "@/lib/composer-ime";
import type { TaskBookmark, TaskSearchHit, TaskSearchResult } from "@/lib/types";
import { parseSearchQuery } from "@shared/text-search.mjs";

const SEARCH_DEBOUNCE_MS = 300;

/** A snippet with the matched ranges marked; the ranges come from the server in snippet offsets. */
function Snippet({ text, highlights }: { text: string; highlights: readonly (readonly [number, number])[] }) {
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of highlights) {
    if (start < cursor || end <= start || end > text.length) continue;
    if (start > cursor) pieces.push(text.slice(cursor, start));
    pieces.push(
      <mark key={start} className="rounded-sm bg-[var(--find-match-bg)] px-px text-[var(--find-match-fg)]">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <>{pieces}</>;
}

function RoleIcon({ role }: { role: "user" | "assistant" }) {
  return role === "user"
    ? <UserRound className="h-3.5 w-3.5" aria-label="ユーザー" role="img" />
    : <Bot className="h-3.5 w-3.5" aria-label="アシスタント" role="img" />;
}

const controlSize = "h-11 w-11 @min-[500px]/task:h-9 @min-[500px]/task:w-9";

/**
 * In-session search and bookmarks. Search runs on the server over the whole session; the timeline
 * paints the matches it has loaded and loads older history on demand when a hit lies further back.
 */
export function TaskFindPanel({ taskId, find }: { taskId: string; find: TaskFind }) {
  const [query, setQuery] = useState(find.queryMemory.current);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [result, setResult] = useState<TaskSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(-1);
  const [list, setList] = useState<"results" | "bookmarks" | null>(null);
  const [jumping, setJumping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const goSeqRef = useRef(0);
  // A query restored on reopen only refreshes the results; the timeline stays put until the user steps.
  const restoredRef = useRef(find.queryMemory.current !== "");
  // The hook returns a fresh object each render; effects and handlers read the latest through a ref.
  const findRef = useRef(find);
  findRef.current = find;
  const terms = useMemo(() => parseSearchQuery(query), [query]);
  const hits = result?.hits ?? [];

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.focusNonce]);

  const go = useCallback(async (messageId: string, searchTerms: readonly string[], flash = false) => {
    const seq = ++goSeqRef.current;
    setJumping(true);
    setNotice(null);
    const outcome = await findRef.current.goToMessage(messageId, { terms: searchTerms, flash });
    if (seq !== goSeqRef.current) return;
    setJumping(false);
    if (outcome === "missing") setNotice("このメッセージを表示できませんでした（履歴から外れている可能性があります）");
  }, []);

  useEffect(() => {
    findRef.current.queryMemory.current = query;
    goSeqRef.current += 1;
    setJumping(false);
    setNotice(null);
    if (terms.length === 0) {
      setStatus("idle");
      setResult(null);
      setError(null);
      setIndex(-1);
      findRef.current.highlight([], null);
      return;
    }
    // What is already loaded lights up at once; the server then searches the whole session.
    findRef.current.highlight(terms, null);
    setStatus("loading");
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getJson<TaskSearchResult>(
        `/api/tasks/${encodeURIComponent(taskId)}/search`,
        { q: query },
        { signal: controller.signal },
      )
        .then((next) => {
          // A response that lands after the query changed belongs to a search nobody is waiting for.
          if (controller.signal.aborted) return;
          const found = Array.isArray(next?.hits) ? next.hits : [];
          setResult({ terms: next?.terms ?? terms, total: next?.total ?? found.length, truncated: next?.truncated === true, hits: found });
          setStatus("ready");
          // A multi-word query matches whole messages: paint only those, not rows holding one of the words.
          findRef.current.highlight(terms, null, terms.length > 1 ? new Set(found.map((hit) => hit.messageId)) : null);
          // Start from the newest hit, like scrolling back from the bottom of a chat.
          const start = found.length - 1;
          if (restoredRef.current) {
            restoredRef.current = false;
            setIndex(-1);
            return;
          }
          setIndex(start);
          if (start >= 0) void go(found[start]!.messageId, terms);
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          setStatus("error");
          setError(failure instanceof Error ? failure.message : "検索できませんでした");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, terms, taskId, go]);

  useEffect(() => {
    if (list === "bookmarks") void findRef.current.refreshBookmarks({ verify: true });
  }, [list]);

  useEffect(() => {
    if (list !== "results") return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [list, index]);

  const step = (direction: 1 | -1) => {
    if (hits.length === 0) return;
    restoredRef.current = false;
    // Before the first jump (a restored query) both directions start from the newest hit.
    const next = index < 0 ? hits.length - 1 : (index + direction + hits.length) % hits.length;
    setIndex(next);
    void go(hits[next]!.messageId, terms);
  };

  const selectHit = (hit: TaskSearchHit, position: number) => {
    setIndex(position);
    setList(null);
    void go(hit.messageId, terms);
  };

  const openBookmark = (bookmark: TaskBookmark) => {
    setList(null);
    void go(bookmark.messageId, terms, true);
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || isImeComposingEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (list !== null) setList(null);
    else find.closePanel();
  };

  // "3/12" while stepping, "12件" before the first jump; a trailing + marks a truncated list.
  const position = index < 0 ? `${hits.length}件` : `${index + 1}/${hits.length}`;
  const counter =
    status === "loading" ? "検索中…"
    : status === "error" ? "検索エラー"
    : status === "ready" ? (hits.length === 0 ? "0件" : `${position}${result?.truncated ? "+" : ""}`)
    : "";
  const canStep = status === "ready" && hits.length > 0;
  const missing = find.missingIds;

  return (
    <div
      role="search"
      aria-label="セッション内検索"
      onKeyDown={onPanelKeyDown}
      className="relative z-40 shrink-0 border-b border-bot-outline bg-bot-chat px-3 py-1.5 @min-[500px]/task:px-4"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-1 gap-y-0.5">
        <label className="flex h-11 min-w-[11rem] flex-1 basis-48 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-muted focus-within:border-border-strong @min-[500px]/task:h-9">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              restoredRef.current = false;
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (isImeComposingEvent(event)) return;
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "ArrowDown" && list === null && hits.length > 0) {
                event.preventDefault();
                setList("results");
              }
            }}
            placeholder="セッション内を検索"
            aria-label="セッション内を検索"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            className="min-w-0 flex-1 appearance-none bg-transparent text-text outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="検索語を消去"
              title="検索語を消去"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="-mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-text"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={status === "ready" && hits.length > 0 ? `検索結果一覧（${hits.length}件）` : "検索結果一覧"}
            aria-expanded={list === "results"}
            title="検索結果一覧"
            disabled={!canStep}
            onClick={() => setList((current) => (current === "results" ? null : "results"))}
            className={cx(
              "inline-flex h-11 min-w-12 items-center justify-center gap-1 rounded-lg px-1.5 text-xs tabular-nums @min-[500px]/task:h-9",
              canStep ? "text-text hover:bg-surface-2" : "text-muted",
              list === "results" && "bg-surface-2",
            )}
          >
            {status === "loading" || jumping ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{counter}</span>
            {canStep && <ChevronDown aria-hidden="true" className={cx("h-3 w-3 text-faint transition-transform", list === "results" && "rotate-180")} />}
          </button>
          <Button variant="ghost" size="icon" className={controlSize} aria-label="前の一致" title="前の一致（Shift+Enter）" disabled={!canStep} onClick={() => step(-1)}>
            <ChevronUp aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className={controlSize} aria-label="次の一致" title="次の一致（Enter）" disabled={!canStep} onClick={() => step(1)}>
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cx(controlSize, "relative", list === "bookmarks" && "bg-surface-2 text-text")}
            aria-label={`ブックマーク一覧（${find.bookmarks.length}件）`}
            aria-expanded={list === "bookmarks"}
            title="ブックマーク一覧"
            onClick={() => setList((current) => (current === "bookmarks" ? null : "bookmarks"))}
          >
            <Bookmark aria-hidden="true" className="h-4 w-4" fill={find.bookmarks.length > 0 ? "currentColor" : "none"} />
            {find.bookmarks.length > 0 && (
              <span aria-hidden="true" className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-medium leading-4 text-primary-fg">
                {find.bookmarks.length > 99 ? "99+" : find.bookmarks.length}
              </span>
            )}
          </Button>
          <Button variant="ghost" size="icon" className={controlSize} aria-label="検索を閉じる" title="閉じる（Esc）" onClick={find.closePanel}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only">{jumping ? "移動中…" : counter}</span>
      {status === "error" && error && (
        <p role="alert" className="mx-auto w-full max-w-5xl px-1 pt-1 text-xs text-danger">{error}</p>
      )}
      {notice && (
        <p role="status" className="mx-auto w-full max-w-5xl px-1 pt-1 text-xs text-warning">{notice}</p>
      )}
      {list !== null && (
        <div className="absolute inset-x-0 top-full px-3 pt-1 @min-[500px]/task:px-4">
          <div
            ref={listRef}
            className="mx-auto max-h-[min(24rem,55dvh)] w-full max-w-5xl overflow-y-auto overscroll-y-contain rounded-card border border-border bg-surface shadow-lg"
          >
            {list === "results" ? (
              <>
                {result?.truncated && (
                  <p className="border-b border-border px-3 py-2 text-xs text-muted">
                    一致 {result.total} 件のうち、新しい {hits.length} 件を表示しています。検索語を絞ると古いメッセージも探せます。
                  </p>
                )}
                <ul role="listbox" aria-label="検索結果" className="divide-y divide-border">
                  {hits.map((hit, position) => (
                    <li key={hit.messageId} role="presentation">
                      <button
                        type="button"
                        role="option"
                        aria-selected={position === index}
                        onClick={() => selectHit(hit, position)}
                        className={cx(
                          "flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2",
                          position === index && "bg-surface-2",
                        )}
                      >
                        <span className="mt-0.5 shrink-0 text-muted"><RoleIcon role={hit.role} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] text-faint">
                            {formatMessageTime(hit.createdAt)}{hit.count > 1 ? ` · ${hit.count}件の一致` : ""}
                          </span>
                          <span className="block text-text [overflow-wrap:anywhere]">
                            <Snippet text={hit.snippet} highlights={hit.highlights} />
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : find.bookmarks.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted">
                ブックマークはまだありません。メッセージ下の「ブックマーク」ボタンで追加できます。
              </p>
            ) : (
              <ul aria-label="ブックマーク" className="divide-y divide-border">
                {find.bookmarks.map((bookmark) => {
                  const gone = missing?.has(bookmark.messageId) === true;
                  return (
                    <li key={bookmark.messageId} className="flex items-stretch hover:bg-surface-2">
                      <button
                        type="button"
                        disabled={gone}
                        onClick={() => openBookmark(bookmark)}
                        className="flex min-h-11 min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="mt-0.5 shrink-0 text-muted"><RoleIcon role={bookmark.role} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] text-faint">
                            {formatMessageTime(bookmark.messageCreatedAt || bookmark.createdAt)}
                            {gone && <span className="ml-1.5 text-warning">履歴に見つかりません</span>}
                          </span>
                          <span className="block text-text [overflow-wrap:anywhere]">
                            {bookmark.preview || "（本文なし）"}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="ブックマークを削除"
                        title="ブックマークを削除"
                        onClick={() => find.removeBookmark(bookmark.messageId)}
                        className="inline-flex w-11 shrink-0 items-center justify-center text-faint hover:text-danger"
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  clearMatches,
  collectMatches,
  findMessageArticle,
  findMessageRow,
  isRangeRendered,
  isRendered,
  paintMatches,
  scrollTargetIntoView,
  SEARCH_TEXT_ATTRIBUTE,
  type DomMatch,
} from "@/lib/dom-find";
import type { TaskBookmark, TaskMessageHistory, UiMessage } from "@/lib/types";
import { isStableMessageId, searchableMessageText } from "@shared/task-search.mjs";

export type FindGoResult = "ok" | "missing" | "cancelled";

export type TaskFind = {
  open: boolean;
  openPanel: () => void;
  closePanel: () => void;
  /** Bumped when the panel is asked to open again, so an open panel refocuses its input. */
  focusNonce: number;
  /** The last query, kept while the panel is closed and reopened. */
  queryMemory: { current: string };
  bookmarks: TaskBookmark[];
  bookmarkedIds: ReadonlySet<string>;
  /** Bookmarked messages the session no longer contains; null until verified. */
  missingIds: ReadonlySet<string> | null;
  /** Stable. Ignores messages without a persisted id (a streaming tail). */
  toggleBookmark: (message: UiMessage) => void;
  removeBookmark: (messageId: string) => void;
  refreshBookmarks: (options?: { verify?: boolean }) => Promise<void>;
  /** Load history until the message is mounted, reveal it, scroll to it and paint `terms` on it. */
  goToMessage: (messageId: string, options?: { terms?: readonly string[]; flash?: boolean }) => Promise<FindGoResult>;
  /**
   * Paint matches of `terms` in the timeline (empty clears); `activeMessageId` gets the stronger color.
   * `onlyMessageIds` limits the paint to those messages (a multi-word query matches whole messages,
   * so a row that holds just one of the words is not a hit).
   */
  highlight: (terms: readonly string[], activeMessageId: string | null, onlyMessageIds?: ReadonlySet<string> | null) => void;
  /** Asks the work log that holds `messageId` to open; `nonce` re-triggers an already revealed one. */
  reveal: { messageId: string; nonce: number } | null;
};

type Ref<T> = { current: T };

export type UseTaskFindOptions = {
  taskId: string;
  /** A hidden tab keeps its TaskView mounted but must not take shortcuts or fetch. */
  active: boolean;
  rootRef: Ref<HTMLElement | null>;
  scrollRef: Ref<HTMLElement | null>;
  contentRef: Ref<HTMLElement | null>;
  /** Follow-the-tail flag of the timeline; a jump must turn it off. */
  stickRef: Ref<boolean>;
  messagesRef: Ref<readonly UiMessage[]>;
  historyRef: Ref<TaskMessageHistory>;
  historyLoadingRef: Ref<boolean>;
  /** Loads the next older page; the page's messages, or null when nothing was loaded. */
  loadOlder: () => Promise<readonly UiMessage[] | null>;
  onError: (message: string) => void;
};

/** Marks a timeline task view so the find shortcut can tell how many are on screen. */
export const TASK_VIEW_ATTRIBUTE = "data-task-view";

const ROW_WAIT_MS = 1_500;
const FLASH_MS = 2_200;
const FIND_SCROLL_MARGIN = 12;
const EMPTY_BOOKMARKS: TaskBookmark[] = [];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A frame, or 50ms in a background tab where animation frames never run. */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

async function waitFor<T>(read: () => T | null | undefined, timeoutMs: number, cancelled: () => boolean): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (cancelled() || performance.now() >= deadline) return null;
    await nextFrame();
  }
}

/** The bookmark list of a server payload, or null when the payload is not one. */
export function parseBookmarks(payload: unknown): TaskBookmark[] | null {
  const list = (payload as { bookmarks?: unknown } | null | undefined)?.bookmarks;
  if (!Array.isArray(list)) return null;
  return list.filter((entry): entry is TaskBookmark => {
    const item = entry as Partial<TaskBookmark> | null;
    return Boolean(item) && typeof item!.messageId === "string" && (item!.role === "user" || item!.role === "assistant");
  });
}

function parseMissing(payload: unknown): string[] | null {
  const missing = (payload as { missing?: unknown } | null | undefined)?.missing;
  return Array.isArray(missing) ? missing.filter((id): id is string => typeof id === "string") : null;
}

export function sortBookmarks(list: readonly TaskBookmark[]): TaskBookmark[] {
  return [...list].sort(
    (a, b) => a.messageCreatedAt - b.messageCreatedAt || a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId),
  );
}

/** The one-line text kept with a bookmark so it stays recognisable when the message is gone. */
export function bookmarkPreview(message: UiMessage): string {
  return searchableMessageText(message).replace(/\s+/gu, " ").trim().slice(0, 240);
}

function isOnlyVisibleTaskView(root: Element): boolean {
  const visible = Array.from(document.querySelectorAll(`[${TASK_VIEW_ATTRIBUTE}]`)).filter(isRendered);
  return visible.length === 1 && visible[0] === root;
}

type BookmarkState = { taskId: string; list: TaskBookmark[]; missing: string[] | null };

export function useTaskFind({
  taskId,
  active,
  rootRef,
  scrollRef,
  contentRef,
  stickRef,
  messagesRef,
  historyRef,
  historyLoadingRef,
  loadOlder,
  onError,
}: UseTaskFindOptions): TaskFind {
  const [open, setOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [reveal, setReveal] = useState<TaskFind["reveal"]>(null);
  const [bookmarkState, setBookmarkState] = useState<BookmarkState>({ taskId, list: EMPTY_BOOKMARKS, missing: null });
  const bookmarkStateRef = useRef(bookmarkState);
  bookmarkStateRef.current = bookmarkState;
  const requestSeqRef = useRef(0);
  const jumpSeqRef = useRef(0);
  const revealNonceRef = useRef(0);
  const termsRef = useRef<readonly string[]>([]);
  const activeMessageIdRef = useRef<string | null>(null);
  const onlyMessageIdsRef = useRef<ReadonlySet<string> | null>(null);
  const activeRowRef = useRef<HTMLElement | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryMemory = useRef("");
  const aliveRef = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  const bookmarks = bookmarkState.taskId === taskId ? bookmarkState.list : EMPTY_BOOKMARKS;
  const missing = bookmarkState.taskId === taskId ? bookmarkState.missing : null;
  const bookmarkedIds = useMemo(() => new Set(bookmarks.map((bookmark) => bookmark.messageId)), [bookmarks]);
  const missingIds = useMemo(() => (missing ? new Set(missing) : null), [missing]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearMatches(contentRef);
    };
  }, [contentRef]);

  const markActiveRow = useCallback((row: HTMLElement | null, flash: boolean) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = null;
    if (activeRowRef.current && activeRowRef.current !== row) activeRowRef.current.removeAttribute("data-find-active");
    activeRowRef.current = row;
    if (!row) return;
    row.setAttribute("data-find-active", "");
    if (!flash) return;
    flashTimerRef.current = setTimeout(() => {
      row.removeAttribute("data-find-active");
      if (activeRowRef.current === row) activeRowRef.current = null;
    }, FLASH_MS);
  }, []);

  const repaint = useCallback((): DomMatch[] => {
    const root = contentRef.current;
    const terms = termsRef.current;
    if (!root || terms.length === 0) {
      clearMatches(contentRef);
      return [];
    }
    const only = onlyMessageIdsRef.current;
    const found = collectMatches(root, terms);
    const matches = only ? found.filter((match) => match.messageId !== null && only.has(match.messageId)) : found;
    paintMatches(matches, activeMessageIdRef.current, contentRef);
    return matches;
  }, [contentRef]);

  const highlight = useCallback((
    terms: readonly string[],
    activeMessageId: string | null,
    onlyMessageIds: ReadonlySet<string> | null = null,
  ) => {
    // A new query supersedes a jump still paging history in for the old one.
    jumpSeqRef.current += 1;
    termsRef.current = terms;
    activeMessageIdRef.current = activeMessageId;
    onlyMessageIdsRef.current = onlyMessageIds;
    repaint();
  }, [repaint]);

  // A reused pane switches tasks without remounting: nothing of the previous task may linger.
  useLayoutEffect(() => {
    setOpen(false);
    setReveal(null);
    queryMemory.current = "";
    jumpSeqRef.current += 1;
    termsRef.current = [];
    activeMessageIdRef.current = null;
    onlyMessageIdsRef.current = null;
    clearMatches(contentRef);
    markActiveRow(null, false);
  }, [taskId, contentRef, markActiveRow]);

  useEffect(() => {
    if (open) return;
    jumpSeqRef.current += 1;
    termsRef.current = [];
    activeMessageIdRef.current = null;
    onlyMessageIdsRef.current = null;
    clearMatches(contentRef);
    markActiveRow(null, false);
  }, [open, contentRef, markActiveRow]);

  // Streaming text and newly loaded pages mount new rows: keep the highlight in step while searching.
  useEffect(() => {
    if (!open) return;
    const root = contentRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver((records) => {
      if (termsRef.current.length === 0 || timer !== null) return;
      const relevant = records.some((record) => {
        if (record.type !== "characterData") return true;
        return Boolean(record.target.parentElement?.closest(`[${SEARCH_TEXT_ATTRIBUTE}]`));
      });
      if (!relevant) return;
      timer = setTimeout(() => {
        timer = null;
        repaint();
      }, 250);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [open, contentRef, repaint]);

  const openPanel = useCallback(() => {
    setOpen(true);
    setFocusNonce((nonce) => nonce + 1);
  }, []);
  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      const root = rootRef.current;
      if (!root || !isRendered(root)) return;
      const target = event.target;
      const inside = target instanceof Node && root.contains(target);
      const onBody = !(target instanceof Node) || target === document.body || target === document.documentElement;
      // With several panes on screen only the one holding focus answers; focus on the page itself
      // belongs to the lone pane, and anything else is left to the browser's own find.
      if (!inside && !(onBody && isOnlyVisibleTaskView(root))) return;
      event.preventDefault();
      openPanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, rootRef, openPanel]);

  const refreshBookmarks = useCallback(async ({ verify = false }: { verify?: boolean } = {}) => {
    const seq = ++requestSeqRef.current;
    try {
      const payload = await Promise.resolve(
        getJson<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/bookmarks`, verify ? { verify: "1" } : undefined),
      );
      if (seq !== requestSeqRef.current || !aliveRef.current) return;
      const list = parseBookmarks(payload);
      if (!list) return;
      setBookmarkState((current) => ({
        taskId,
        list,
        missing: verify ? parseMissing(payload) : current.taskId === taskId ? current.missing : null,
      }));
    } catch {
      // The bookmark marks stay as they are; a failed read is not worth interrupting the session.
    }
  }, [taskId]);

  useEffect(() => {
    if (!active) return;
    void refreshBookmarks();
    const onVisible = () => {
      if (!document.hidden) void refreshBookmarks();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, refreshBookmarks]);

  const mutateBookmarks = useCallback((
    optimistic: TaskBookmark[],
    request: () => Promise<unknown>,
  ) => {
    const seq = ++requestSeqRef.current;
    setBookmarkState((current) => ({ taskId, list: optimistic, missing: current.taskId === taskId ? current.missing : null }));
    bookmarkStateRef.current = { ...bookmarkStateRef.current, taskId, list: optimistic };
    new Promise<unknown>((resolve) => resolve(request()))
      .then((payload) => {
        if (seq !== requestSeqRef.current || !aliveRef.current) return;
        const list = parseBookmarks(payload);
        if (list) setBookmarkState((current) => ({ taskId, list, missing: current.taskId === taskId ? current.missing : null }));
      })
      .catch((error: unknown) => {
        if (!aliveRef.current) return;
        onErrorRef.current(error instanceof Error ? error.message : "ブックマークを更新できませんでした");
        // Show what the server really holds instead of the optimistic guess.
        void refreshBookmarks();
      });
  }, [taskId, refreshBookmarks]);

  const bookmarksBase = `/api/tasks/${encodeURIComponent(taskId)}/bookmarks`;

  const toggleBookmark = useCallback((message: UiMessage) => {
    if (!isStableMessageId(message.id) || (message.role !== "user" && message.role !== "assistant")) return;
    const state = bookmarkStateRef.current;
    const current = state.taskId === taskId ? state.list : EMPTY_BOOKMARKS;
    if (current.some((entry) => entry.messageId === message.id)) {
      mutateBookmarks(
        current.filter((entry) => entry.messageId !== message.id),
        () => sendJson<unknown>(`${bookmarksBase}?messageId=${encodeURIComponent(message.id)}`, undefined, "DELETE"),
      );
      return;
    }
    const entry: TaskBookmark = {
      messageId: message.id,
      role: message.role,
      messageCreatedAt: message.createdAt,
      createdAt: Date.now(),
      preview: bookmarkPreview(message),
    };
    mutateBookmarks(
      sortBookmarks([...current, entry]),
      () => sendJson<unknown>(bookmarksBase, {
        messageId: entry.messageId,
        role: entry.role,
        messageCreatedAt: entry.messageCreatedAt,
        preview: entry.preview,
      }, "PUT"),
    );
  }, [taskId, bookmarksBase, mutateBookmarks]);

  const removeBookmark = useCallback((messageId: string) => {
    const state = bookmarkStateRef.current;
    const current = state.taskId === taskId ? state.list : EMPTY_BOOKMARKS;
    if (!current.some((entry) => entry.messageId === messageId)) return;
    mutateBookmarks(
      current.filter((entry) => entry.messageId !== messageId),
      () => sendJson<unknown>(`${bookmarksBase}?messageId=${encodeURIComponent(messageId)}`, undefined, "DELETE"),
    );
  }, [taskId, bookmarksBase, mutateBookmarks]);

  /** Pages older history in until `messageId` is part of the timeline; false when it never shows up. */
  const ensureMessageLoaded = useCallback(async (messageId: string, cancelled: () => boolean): Promise<boolean> => {
    const isLoaded = () => messagesRef.current.some((message) => message.id === messageId);
    const seenCursors = new Set<string>();
    for (;;) {
      if (cancelled()) return false;
      if (isLoaded()) return true;
      // A "load older" click already in flight moves the cursor this loop depends on; let it land first.
      for (let waited = 0; historyLoadingRef.current && waited < 10_000 && !cancelled(); waited += 50) await sleep(50);
      if (cancelled()) return false;
      if (isLoaded()) return true;
      const history = historyRef.current;
      const cursor = history.nextCursor;
      if (!history.hasMore || !cursor || seenCursors.has(cursor)) return false;
      seenCursors.add(cursor);
      const page = await loadOlderRef.current();
      if (page === null) return false;
      if (page.some((message) => message.id === messageId)) {
        // The row mounts on the render that follows the state update.
        await nextFrame();
        await nextFrame();
        return true;
      }
    }
  }, [messagesRef, historyRef, historyLoadingRef]);

  const goToMessage = useCallback(async (
    messageId: string,
    { terms = [], flash = false }: { terms?: readonly string[]; flash?: boolean } = {},
  ): Promise<FindGoResult> => {
    const seq = ++jumpSeqRef.current;
    const cancelled = () => jumpSeqRef.current !== seq || !aliveRef.current;
    if (!(await ensureMessageLoaded(messageId, cancelled))) return cancelled() ? "cancelled" : "missing";
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return "missing";
    let row = await waitFor(() => findMessageRow(content, messageId), ROW_WAIT_MS, cancelled);
    if (cancelled()) return "cancelled";
    if (!row) return "missing";
    const rendered = () => {
      const article = findMessageArticle(row!, messageId);
      return article && isRendered(article) ? article : null;
    };
    if (!rendered()) {
      // The message sits in a collapsed work log: ask it to open, then wait for its text to mount.
      setReveal({ messageId, nonce: ++revealNonceRef.current });
      await waitFor(rendered, ROW_WAIT_MS, cancelled);
      if (cancelled()) return "cancelled";
      row = findMessageRow(content, messageId) ?? row;
    }
    termsRef.current = terms;
    activeMessageIdRef.current = terms.length > 0 ? messageId : null;
    const matches = repaint();
    markActiveRow(row, flash);
    stickRef.current = false;
    const first = matches.find((match) => match.messageId === messageId && isRangeRendered(match.range));
    // Keep the message's own top edge in view when the match is near it; a match deep in a long message
    // sits a third of the way down instead, so there is context above it.
    const rowTop = row.getBoundingClientRect().top;
    const matchTop = first?.range.getClientRects()[0]?.top ?? rowTop;
    const lead = Math.min(Math.max(matchTop - rowTop, 0) + FIND_SCROLL_MARGIN, scroller.clientHeight * 0.3);
    scrollTargetIntoView(scroller, first?.range ?? row, Math.max(FIND_SCROLL_MARGIN, lead));
    return "ok";
  }, [ensureMessageLoaded, contentRef, scrollRef, stickRef, repaint, markActiveRow]);

  return {
    open,
    openPanel,
    closePanel,
    focusNonce,
    queryMemory,
    bookmarks,
    bookmarkedIds,
    missingIds,
    toggleBookmark,
    removeBookmark,
    refreshBookmarks,
    goToMessage,
    highlight,
    reveal,
  };
}

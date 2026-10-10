// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBookmark, UiMessage } from "@/lib/types";
import { bookmarkPreview, parseBookmarks, sortBookmarks, useTaskFind, type UseTaskFindOptions } from "./use-task-find";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  scroll: vi.fn(),
  rendered: vi.fn(() => true),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("@/lib/dom-find", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dom-find")>();
  // happy-dom has no layout: every element counts as rendered and scrolling is observed, not performed.
  return { ...actual, isRendered: () => mocks.rendered(), scrollTargetIntoView: mocks.scroll };
});

function message(id: string, role: UiMessage["role"] = "assistant", text = `text of ${id}`, createdAt = 10): UiMessage {
  return { id, role, createdAt, parts: [{ id: `${id}-text`, type: "text", text }] };
}

function bookmark(id: string, overrides: Partial<TaskBookmark> = {}): TaskBookmark {
  return { messageId: id, role: "assistant", messageCreatedAt: 10, createdAt: 20, preview: `preview ${id}`, ...overrides };
}

const textRow = (id: string, text: string) => `<article data-message-id="${id}"><div data-search-text>${text}</div></article>`;

function setup(overrides: Partial<UseTaskFindOptions> = {}) {
  const root = document.createElement("div");
  root.setAttribute("data-task-view", "");
  const scroller = document.createElement("div");
  const content = document.createElement("div");
  scroller.append(content);
  root.append(scroller);
  document.body.append(root);
  const addRow = (ids: string[], inner: string) => {
    const row = document.createElement("div");
    row.setAttribute("data-message-ids", ids.join(" "));
    row.innerHTML = inner;
    content.append(row);
    return row;
  };
  const messages = { current: [message("a"), message("b")] as UiMessage[] };
  const history = { current: { hasMore: false, nextCursor: null as string | null } };
  const loading = { current: false };
  const stick = { current: true };
  const loadOlder = vi.fn(async (): Promise<UiMessage[] | null> => null);
  const onError = vi.fn();
  const props: UseTaskFindOptions = {
    taskId: "task-1",
    active: true,
    rootRef: { current: root },
    scrollRef: { current: scroller },
    contentRef: { current: content },
    stickRef: stick,
    messagesRef: messages,
    historyRef: history,
    historyLoadingRef: loading,
    loadOlder,
    onError,
    ...overrides,
  };
  const hook = renderHook((options: UseTaskFindOptions) => useTaskFind(options), { initialProps: props });
  return { root, scroller, content, addRow, messages, history, loading, stick, loadOlder, onError, hook, props };
}

describe("bookmark helpers", () => {
  it("accepts only well-formed bookmark lists", () => {
    expect(parseBookmarks({ models: [] })).toBeNull();
    expect(parseBookmarks(undefined)).toBeNull();
    expect(parseBookmarks({ bookmarks: "x" })).toBeNull();
    expect(parseBookmarks({ bookmarks: [bookmark("a"), null, { messageId: 3 }, { messageId: "b", role: "system" }] })).toEqual([bookmark("a")]);
  });

  it("orders bookmarks like the timeline and previews one line of text", () => {
    expect(sortBookmarks([bookmark("c", { messageCreatedAt: 30 }), bookmark("a", { messageCreatedAt: 10 }), bookmark("b", { messageCreatedAt: 10, createdAt: 99 })]).map((entry) => entry.messageId)).toEqual(["a", "b", "c"]);
    expect(bookmarkPreview(message("a", "user", "  line one\n\n   line two  "))).toBe("line one line two");
    expect(bookmarkPreview(message("a", "assistant", "あ".repeat(500))).length).toBe(240);
  });
});

describe("useTaskFind bookmarks", () => {
  beforeEach(() => {
    mocks.getJson.mockReset().mockResolvedValue({ bookmarks: [] });
    mocks.sendJson.mockReset();
    mocks.scroll.mockReset();
    mocks.rendered.mockReset().mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("loads the task's bookmarks once active and refetches when the tab shows again", async () => {
    mocks.getJson.mockResolvedValue({ bookmarks: [bookmark("a")] });
    const { hook, props } = setup();
    await waitFor(() => expect(hook.result.current.bookmarkedIds.has("a")).toBe(true));
    expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/task-1/bookmarks", undefined);
    expect(hook.result.current.bookmarks).toEqual([bookmark("a")]);

    mocks.getJson.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(1));
    hook.rerender({ ...props, active: false });
    mocks.getJson.mockClear();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(mocks.getJson).not.toHaveBeenCalled();
  });

  it("does not fetch while the tab is hidden", () => {
    setup({ active: false });
    expect(mocks.getJson).not.toHaveBeenCalled();
  });

  it("ignores payloads that are not bookmark lists", async () => {
    mocks.getJson.mockResolvedValue({ models: [], agents: [] });
    const { hook } = setup();
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(hook.result.current.bookmarks).toEqual([]);
  });

  it("reports unverified bookmarks until the server says which messages are gone", async () => {
    mocks.getJson.mockResolvedValue({ bookmarks: [bookmark("a"), bookmark("b")] });
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.bookmarks).toHaveLength(2));
    expect(hook.result.current.missingIds).toBeNull();

    mocks.getJson.mockResolvedValue({ bookmarks: [bookmark("a"), bookmark("b")], missing: ["b"] });
    await act(async () => { await hook.result.current.refreshBookmarks({ verify: true }); });
    expect(mocks.getJson).toHaveBeenLastCalledWith("/api/tasks/task-1/bookmarks", { verify: "1" });
    expect([...hook.result.current.missingIds!]).toEqual(["b"]);
  });

  it("adds a bookmark at once and settles on the server's list", async () => {
    const { hook } = setup();
    const target = message("a", "user", "ログインを直して", 5);
    let finish!: (value: unknown) => void;
    mocks.sendJson.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    act(() => { hook.result.current.toggleBookmark(target); });

    expect(hook.result.current.bookmarkedIds.has("a")).toBe(true);
    expect(mocks.sendJson).toHaveBeenCalledExactlyOnceWith(
      "/api/tasks/task-1/bookmarks",
      { messageId: "a", role: "user", messageCreatedAt: 5, preview: "ログインを直して" },
      "PUT",
    );
    await act(async () => { finish({ bookmarks: [bookmark("a", { role: "user", preview: "server copy" })] }); });
    expect(hook.result.current.bookmarks[0]?.preview).toBe("server copy");
  });

  it("removes a bookmarked message and through the list", async () => {
    mocks.getJson.mockResolvedValue({ bookmarks: [bookmark("a"), bookmark("b", { messageCreatedAt: 11 })] });
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.bookmarks).toHaveLength(2));
    mocks.sendJson.mockResolvedValueOnce({ bookmarks: [bookmark("b", { messageCreatedAt: 11 })] });

    act(() => { hook.result.current.toggleBookmark(message("a")); });
    expect(hook.result.current.bookmarkedIds.has("a")).toBe(false);
    expect(mocks.sendJson).toHaveBeenLastCalledWith("/api/tasks/task-1/bookmarks?messageId=a", undefined, "DELETE");

    mocks.sendJson.mockResolvedValueOnce({ bookmarks: [] });
    act(() => { hook.result.current.removeBookmark("b"); });
    await waitFor(() => expect(hook.result.current.bookmarks).toEqual([]));
    expect(mocks.sendJson).toHaveBeenLastCalledWith("/api/tasks/task-1/bookmarks?messageId=b", undefined, "DELETE");

    mocks.sendJson.mockClear();
    act(() => { hook.result.current.removeBookmark("never-bookmarked"); });
    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it("rolls back to the server's list and reports the error when saving fails", async () => {
    const { hook, onError } = setup();
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(1));
    mocks.sendJson.mockRejectedValueOnce(new Error("保存できません"));

    act(() => { hook.result.current.toggleBookmark(message("a")); });
    expect(hook.result.current.bookmarkedIds.has("a")).toBe(true);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("保存できません"));
    await waitFor(() => expect(hook.result.current.bookmarkedIds.has("a")).toBe(false));
    expect(mocks.getJson).toHaveBeenCalledTimes(2);
  });

  it("ignores messages that cannot be bookmarked", async () => {
    const { hook } = setup();
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    act(() => {
      hook.result.current.toggleBookmark(message("msg-3"));
      hook.result.current.toggleBookmark(message("summary", "compaction"));
    });
    expect(mocks.sendJson).not.toHaveBeenCalled();
    expect(hook.result.current.bookmarks).toEqual([]);
  });

  it("keeps toggleBookmark stable so memoized rows do not re-render", async () => {
    mocks.getJson.mockResolvedValue({ bookmarks: [bookmark("a")] });
    const { hook } = setup();
    const first = hook.result.current.toggleBookmark;
    await waitFor(() => expect(hook.result.current.bookmarks).toHaveLength(1));
    expect(hook.result.current.toggleBookmark).toBe(first);
  });

  it("forgets the previous task's bookmarks when the pane switches tasks", async () => {
    mocks.getJson.mockResolvedValue({ bookmarks: [bookmark("a")] });
    const { hook, props } = setup();
    await waitFor(() => expect(hook.result.current.bookmarks).toHaveLength(1));
    mocks.getJson.mockResolvedValue({ bookmarks: [] });
    act(() => { hook.result.current.openPanel(); });
    expect(hook.result.current.open).toBe(true);
    hook.rerender({ ...props, taskId: "task-2" });
    expect(hook.result.current.bookmarks).toEqual([]);
    expect(hook.result.current.open).toBe(false);
    await waitFor(() => expect(mocks.getJson).toHaveBeenLastCalledWith("/api/tasks/task-2/bookmarks", undefined));
  });
});

describe("useTaskFind jumping", () => {
  beforeEach(() => {
    mocks.getJson.mockReset().mockResolvedValue({ bookmarks: [] });
    mocks.sendJson.mockReset();
    mocks.scroll.mockReset();
    mocks.rendered.mockReset().mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("scrolls to a loaded message, marks its row and stops following the tail", async () => {
    const { hook, addRow, scroller, stick } = setup();
    const row = addRow(["a"], textRow("a", "find the needle here"));

    let outcome = "";
    await act(async () => { outcome = await hook.result.current.goToMessage("a", { terms: ["needle"] }); });

    expect(outcome).toBe("ok");
    expect(row.hasAttribute("data-find-active")).toBe(true);
    expect(stick.current).toBe(false);
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
    expect(mocks.scroll.mock.calls[0]?.[0]).toBe(scroller);
  });

  it("moves the active mark when jumping again and clears it when the panel closes", async () => {
    const { hook, addRow } = setup();
    const first = addRow(["a"], textRow("a", "one"));
    const second = addRow(["b"], textRow("b", "two"));
    await act(async () => { await hook.result.current.goToMessage("a"); });
    await act(async () => { await hook.result.current.goToMessage("b"); });
    expect(first.hasAttribute("data-find-active")).toBe(false);
    expect(second.hasAttribute("data-find-active")).toBe(true);

    act(() => { hook.result.current.openPanel(); });
    act(() => { hook.result.current.closePanel(); });
    await waitFor(() => expect(second.hasAttribute("data-find-active")).toBe(false));
  });

  it("flashes a bookmark jump and lets the mark fade", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { hook, addRow } = setup();
      const row = addRow(["a"], textRow("a", "one"));
      let outcome: Promise<string> | undefined;
      act(() => { outcome = hook.result.current.goToMessage("a", { flash: true }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(await outcome).toBe("ok");
      expect(row.hasAttribute("data-find-active")).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(row.hasAttribute("data-find-active")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pages older history in until the message is part of the timeline", async () => {
    const { hook, addRow, messages, history, loadOlder } = setup();
    messages.current = [message("m3")];
    history.current = { hasMore: true, nextCursor: "m3" };
    loadOlder
      .mockImplementationOnce(async () => {
        history.current = { hasMore: true, nextCursor: "m2" };
        return [message("m2")];
      })
      .mockImplementationOnce(async () => {
        history.current = { hasMore: false, nextCursor: null };
        addRow(["m1"], textRow("m1", "the old needle"));
        return [message("m1")];
      });

    let outcome = "";
    await act(async () => { outcome = await hook.result.current.goToMessage("m1", { terms: ["needle"] }); });

    expect(outcome).toBe("ok");
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
  });

  it("can reach a hit beyond 100 pages and stops if a cursor stops advancing", async () => {
    const { hook, addRow, messages, history, loadOlder } = setup();
    messages.current = [message("latest")];
    history.current = { hasMore: true, nextCursor: "cursor-0" };
    let pageNumber = 0;
    loadOlder.mockImplementation(async () => {
      pageNumber += 1;
      if (pageNumber === 105) {
        history.current = { hasMore: false, nextCursor: null };
        messages.current = [message("old"), ...messages.current];
        addRow(["old"], textRow("old", "old search hit"));
        return [message("old")];
      }
      history.current = { hasMore: true, nextCursor: `cursor-${pageNumber}` };
      messages.current = [message(`older-${pageNumber}`), ...messages.current];
      return [message(`older-${pageNumber}`)];
    });

    let outcome = "";
    await act(async () => { outcome = await hook.result.current.goToMessage("old", { terms: ["hit"] }); });
    expect(outcome).toBe("ok");
    expect(loadOlder).toHaveBeenCalledTimes(105);

    history.current = { hasMore: true, nextCursor: "stuck" };
    loadOlder.mockResolvedValue([message("not-the-hit")]);
    await act(async () => { outcome = await hook.result.current.goToMessage("missing"); });
    expect(outcome).toBe("missing");
    expect(loadOlder).toHaveBeenCalledTimes(106);
  });

  it("waits for a history load already in flight before paging further", async () => {
    const { hook, addRow, messages, history, loading, loadOlder } = setup();
    messages.current = [message("m2")];
    history.current = { hasMore: true, nextCursor: "m2" };
    loading.current = true;
    setTimeout(() => {
      // The click that was already loading lands the page this jump is after.
      messages.current = [message("m1"), message("m2")];
      history.current = { hasMore: false, nextCursor: null };
      addRow(["m1"], textRow("m1", "text"));
      loading.current = false;
    }, 120);

    let outcome = "";
    await act(async () => { outcome = await hook.result.current.goToMessage("m1"); });

    expect(outcome).toBe("ok");
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("reports a message that never shows up as missing", async () => {
    const { hook, history, loadOlder } = setup();
    history.current = { hasMore: false, nextCursor: null };
    let outcome = "";
    await act(async () => { outcome = await hook.result.current.goToMessage("gone"); });
    expect(outcome).toBe("missing");
    expect(loadOlder).not.toHaveBeenCalled();
    expect(mocks.scroll).not.toHaveBeenCalled();

    history.current = { hasMore: true, nextCursor: "a" };
    loadOlder.mockResolvedValue(null);
    await act(async () => { outcome = await hook.result.current.goToMessage("gone"); });
    expect(outcome).toBe("missing");
  });

  it("is cancelled by a newer query while it is still paging", async () => {
    const { hook, history, messages, loadOlder } = setup();
    messages.current = [message("m3")];
    history.current = { hasMore: true, nextCursor: "m3" };
    let release!: (page: UiMessage[]) => void;
    loadOlder.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    let outcome: Promise<string> | undefined;
    act(() => { outcome = hook.result.current.goToMessage("m1"); });
    act(() => { hook.result.current.highlight(["new"], null); });
    await act(async () => { release([message("m2")]); });

    expect(await outcome).toBe("cancelled");
    expect(mocks.scroll).not.toHaveBeenCalled();
  });

  it("asks the work log holding a collapsed message to open, then scrolls once its text is there", async () => {
    const { hook, addRow } = setup();
    const row = addRow(["a", "b"], "<details><summary>作業ログ</summary></details>");

    let outcome: Promise<string> | undefined;
    act(() => { outcome = hook.result.current.goToMessage("b", { terms: ["needle"] }); });
    await waitFor(() => expect(hook.result.current.reveal).toEqual({ messageId: "b", nonce: 1 }));
    expect(mocks.scroll).not.toHaveBeenCalled();

    // The log opens and mounts the message's article.
    row.innerHTML = textRow("b", "a needle in the log");
    expect(await outcome).toBe("ok");
    expect(mocks.scroll).toHaveBeenCalledTimes(1);

    act(() => { void hook.result.current.goToMessage("b"); });
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalledTimes(2));
    expect(hook.result.current.reveal).toEqual({ messageId: "b", nonce: 1 });
  });
});

describe("useTaskFind shortcut", () => {
  beforeEach(() => {
    mocks.getJson.mockReset().mockResolvedValue({ bookmarks: [] });
    mocks.rendered.mockReset().mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  const press = (target: EventTarget, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  };

  it("opens on Ctrl+F or Cmd+F from inside the pane and takes the key from the browser", () => {
    const { hook, root } = setup();
    const inner = document.createElement("textarea");
    root.append(inner);
    const event = press(inner);
    expect(event.defaultPrevented).toBe(true);
    expect(hook.result.current.open).toBe(true);
    const nonce = hook.result.current.focusNonce;

    press(inner, { ctrlKey: false, metaKey: true, key: "F" });
    expect(hook.result.current.open).toBe(true);
    expect(hook.result.current.focusNonce).toBeGreaterThan(nonce);
  });

  it("opens bookmarks directly and restores search mode on Ctrl+F", () => {
    const { hook, root } = setup();
    act(() => hook.result.current.openPanel("bookmarks"));
    expect(hook.result.current.open).toBe(true);
    expect(hook.result.current.panelMode).toBe("bookmarks");
    const nonce = hook.result.current.focusNonce;
    press(root);
    expect(hook.result.current.panelMode).toBe("search");
    expect(hook.result.current.focusNonce).toBeGreaterThan(nonce);
  });

  it("answers for the lone pane when nothing is focused", () => {
    const { hook } = setup();
    const event = press(document.body);
    expect(event.defaultPrevented).toBe(true);
    expect(hook.result.current.open).toBe(true);
  });

  it("leaves the browser's find alone when another pane or control has the focus", () => {
    const first = setup();
    const second = setup();
    const outside = document.createElement("input");
    document.body.append(outside);

    expect(press(document.body).defaultPrevented).toBe(false);
    expect(press(outside).defaultPrevented).toBe(false);
    expect(first.hook.result.current.open).toBe(false);
    expect(second.hook.result.current.open).toBe(false);

    const inner = document.createElement("div");
    second.root.append(inner);
    expect(press(inner).defaultPrevented).toBe(true);
    expect(second.hook.result.current.open).toBe(true);
    expect(first.hook.result.current.open).toBe(false);
  });

  it("ignores other combinations, composition and hidden tabs", () => {
    const { hook, props, root } = setup();
    expect(press(root, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(root, { altKey: true }).defaultPrevented).toBe(false);
    expect(press(root, { key: "g" }).defaultPrevented).toBe(false);
    expect(press(root, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(press(root, { isComposing: true }).defaultPrevented).toBe(false);
    expect(hook.result.current.open).toBe(false);

    hook.rerender({ ...props, active: false });
    expect(press(root).defaultPrevented).toBe(false);
    expect(hook.result.current.open).toBe(false);
  });
});

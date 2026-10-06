// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBookmark, TaskSearchHit, TaskSearchResult } from "@/lib/types";
import { TaskFindPanel } from "./TaskFindPanel";
import type { TaskFind } from "./use-task-find";

const mocks = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: vi.fn() }));

function hit(id: string, snippet: string, highlights: [number, number][], overrides: Partial<TaskSearchHit> = {}): TaskSearchHit {
  return { messageId: id, role: "assistant", createdAt: new Date(2026, 0, 2, 3, 4).getTime(), snippet, highlights, count: 1, ...overrides };
}

function result(hits: TaskSearchHit[], overrides: Partial<TaskSearchResult> = {}): TaskSearchResult {
  return { terms: ["needle"], total: hits.length, truncated: false, hits, ...overrides };
}

function bookmark(id: string, overrides: Partial<TaskBookmark> = {}): TaskBookmark {
  return { messageId: id, role: "user", messageCreatedAt: new Date(2026, 0, 2, 3, 4).getTime(), createdAt: 1, preview: `preview ${id}`, ...overrides };
}

function fakeFind(overrides: Partial<TaskFind> = {}): TaskFind {
  return {
    open: true,
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    focusNonce: 0,
    queryMemory: { current: "" },
    bookmarks: [],
    bookmarkedIds: new Set(),
    missingIds: null,
    toggleBookmark: vi.fn(),
    removeBookmark: vi.fn(),
    refreshBookmarks: vi.fn(async () => undefined),
    goToMessage: vi.fn(async () => "ok" as const),
    highlight: vi.fn(),
    reveal: null,
    ...overrides,
  };
}

const THREE = [
  hit("a", "first needle here", [[6, 12]]),
  hit("b", "second needle there", [[7, 13]], { role: "user", count: 2 }),
  hit("c", "third needle", [[6, 12]]),
];

function renderPanel(find: TaskFind) {
  return render(<TaskFindPanel taskId="task 1" find={find} />);
}

const searchBox = () => screen.getByRole("searchbox", { name: "セッション内を検索" }) as HTMLInputElement;
const type = (value: string) => fireEvent.change(searchBox(), { target: { value } });

describe("TaskFindPanel search", () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
  });
  afterEach(cleanup);

  it("focuses the field, lights up loaded text at once and searches the session after a pause", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    expect(document.activeElement).toBe(searchBox());

    type("needle");
    expect(find.highlight).toHaveBeenLastCalledWith(["needle"], null);
    expect(mocks.getJson).not.toHaveBeenCalled();

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(1));
    expect(mocks.getJson).toHaveBeenCalledWith(
      "/api/tasks/task%201/search",
      { q: "needle" },
      { signal: expect.any(AbortSignal) },
    );
    // Starts from the newest hit, like scrolling back from the bottom of a chat.
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledWith("c", { terms: ["needle"], flash: false }));
    expect(screen.getByRole("button", { name: /検索結果一覧/ }).textContent).toContain("3/3");
    expect(find.queryMemory.current).toBe("needle");
  });

  it("restores the remembered query and refreshes its results without moving the timeline", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind({ queryMemory: { current: "needle" } });
    renderPanel(find);
    expect(searchBox().value).toBe("needle");
    await waitFor(() => expect(screen.getByRole("button", { name: /検索結果一覧/ }).textContent).toContain("3件"));
    expect(find.goToMessage).not.toHaveBeenCalled();

    // The first step from a restored query starts at the newest hit in either direction.
    fireEvent.keyDown(searchBox(), { key: "Enter", shiftKey: true });
    expect(find.goToMessage).toHaveBeenLastCalledWith("c", { terms: ["needle"], flash: false });
  });

  it("jumps to the newest hit as soon as an edited query is answered", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind({ queryMemory: { current: "need" } });
    renderPanel(find);
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(1));
    type("needle");
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledWith("c", { terms: ["needle"], flash: false }));
  });

  it("paints only whole-message hits for a multi-word query, everything for a single word", async () => {
    mocks.getJson.mockResolvedValue(result(THREE, { terms: ["foo", "bar"] }));
    const find = fakeFind();
    renderPanel(find);
    type("foo bar");
    await waitFor(() => expect(find.highlight).toHaveBeenLastCalledWith(["foo", "bar"], null, new Set(["a", "b", "c"])));
    type("foo");
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(find.highlight).toHaveBeenLastCalledWith(["foo"], null, null));
  });

  it("steps through the hits with Enter and Shift+Enter and wraps around", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(find.goToMessage).toHaveBeenLastCalledWith("a", { terms: ["needle"], flash: false });
    expect(screen.getByRole("button", { name: /検索結果一覧/ }).textContent).toContain("1/3");
    fireEvent.keyDown(searchBox(), { key: "Enter", shiftKey: true });
    expect(find.goToMessage).toHaveBeenLastCalledWith("c", { terms: ["needle"], flash: false });
    fireEvent.click(screen.getByRole("button", { name: "前の一致" }));
    expect(find.goToMessage).toHaveBeenLastCalledWith("b", { terms: ["needle"], flash: false });
    fireEvent.click(screen.getByRole("button", { name: "次の一致" }));
    expect(find.goToMessage).toHaveBeenLastCalledWith("c", { terms: ["needle"], flash: false });
  });

  it("does not step while an IME is composing", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(searchBox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(searchBox(), { key: "Enter", keyCode: 229 });
    expect(find.goToMessage).toHaveBeenCalledTimes(1);
  });

  it("lists the hits with marked snippets and jumps to the chosen one", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /検索結果一覧/ }));
    const options = within(screen.getByRole("listbox", { name: "検索結果" })).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.textContent).toContain("2件の一致");
    expect([...options[0]!.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["needle"]);

    fireEvent.click(options[0]!);
    expect(find.goToMessage).toHaveBeenLastCalledWith("a", { terms: ["needle"], flash: false });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens the list with the Down arrow", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "検索結果" })).toBeTruthy();
  });

  it("says so when nothing matches and keeps the stepping controls off", async () => {
    mocks.getJson.mockResolvedValue(result([]));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(screen.getByRole("button", { name: /検索結果一覧/ }).textContent).toContain("0件"));
    expect(find.goToMessage).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "次の一致" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /検索結果一覧/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a truncated result list", async () => {
    mocks.getJson.mockResolvedValue(result(THREE, { total: 450, truncated: true }));
    renderPanel(fakeFind());
    type("needle");
    await waitFor(() => expect(screen.getByRole("button", { name: /検索結果一覧/ }).textContent).toContain("3/3+"));
    fireEvent.click(screen.getByRole("button", { name: /検索結果一覧/ }));
    expect(screen.getByText(/一致 450 件のうち、新しい 3 件/)).toBeTruthy();
  });

  it("shows a search failure", async () => {
    mocks.getJson.mockRejectedValue(new Error("Backendから取得できません"));
    renderPanel(fakeFind());
    type("needle");
    expect((await screen.findByRole("alert")).textContent).toBe("Backendから取得できません");
  });

  it("tells the user when the chosen message can no longer be shown", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind({ goToMessage: vi.fn(async () => "missing" as const) });
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(screen.getByText(/表示できませんでした/)).toBeTruthy());
  });

  it("clears the highlight and skips the server for an empty query", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "検索語を消去" }));
    expect(searchBox().value).toBe("");
    expect(find.highlight).toHaveBeenLastCalledWith([], null);
    type("   ");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(mocks.getJson).toHaveBeenCalledTimes(1);
  });

  it("drops a superseded search", async () => {
    let first!: (value: TaskSearchResult) => void;
    mocks.getJson.mockReturnValueOnce(new Promise((resolve) => { first = resolve; }));
    mocks.getJson.mockResolvedValueOnce(result([hit("z", "needle two", [[0, 6]])]));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(1));
    type("needle two");
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledWith("z", expect.anything()));
    await act(async () => { first(result(THREE)); });
    expect(find.goToMessage).not.toHaveBeenCalledWith("c", expect.anything());
  });

  it("closes the list first and the panel on the second Escape", async () => {
    mocks.getJson.mockResolvedValue(result(THREE));
    const find = fakeFind();
    renderPanel(find);
    type("needle");
    await waitFor(() => expect(find.goToMessage).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(find.closePanel).not.toHaveBeenCalled();
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(find.closePanel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "検索を閉じる" }));
    expect(find.closePanel).toHaveBeenCalledTimes(2);
  });

  it("refocuses the field when asked to open again", () => {
    const find = fakeFind();
    const { rerender } = renderPanel(find);
    (document.activeElement as HTMLElement).blur();
    rerender(<TaskFindPanel taskId="task 1" find={{ ...find, focusNonce: 1 }} />);
    expect(document.activeElement).toBe(searchBox());
  });
});

describe("TaskFindPanel bookmarks", () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
  });
  afterEach(cleanup);

  it("shows the count on the bookmark button", () => {
    renderPanel(fakeFind({ bookmarks: [bookmark("a"), bookmark("b")] }));
    expect(screen.getByRole("button", { name: "ブックマーク一覧（2件）" }).textContent).toContain("2");
  });

  it("explains an empty bookmark list", () => {
    const find = fakeFind();
    renderPanel(find);
    fireEvent.click(screen.getByRole("button", { name: "ブックマーク一覧（0件）" }));
    expect(screen.getByText(/ブックマークはまだありません/)).toBeTruthy();
    expect(find.refreshBookmarks).toHaveBeenCalledWith({ verify: true });
  });

  it("jumps to a bookmark with a flash and keeps the search highlight", () => {
    const find = fakeFind({ bookmarks: [bookmark("a", { preview: "ログインを直して" })], queryMemory: { current: "" } });
    renderPanel(find);
    fireEvent.click(screen.getByRole("button", { name: "ブックマーク一覧（1件）" }));
    fireEvent.click(screen.getByRole("button", { name: /ログインを直して/ }));
    expect(find.goToMessage).toHaveBeenCalledWith("a", { terms: [], flash: true });
    expect(screen.queryByRole("list", { name: "ブックマーク" })).toBeNull();
  });

  it("marks bookmarks whose message is gone and lets them be removed", () => {
    const find = fakeFind({
      bookmarks: [bookmark("a"), bookmark("b", { preview: "消えたメッセージ" })],
      missingIds: new Set(["b"]),
    });
    renderPanel(find);
    fireEvent.click(screen.getByRole("button", { name: "ブックマーク一覧（2件）" }));
    const gone = screen.getByRole("button", { name: /消えたメッセージ/ }) as HTMLButtonElement;
    expect(gone.disabled).toBe(true);
    expect(gone.textContent).toContain("履歴に見つかりません");
    expect((screen.getByRole("button", { name: /preview a/ }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getAllByRole("button", { name: "ブックマークを削除" })[1]!);
    expect(find.removeBookmark).toHaveBeenCalledWith("b");
  });

  it("shows a bookmark without text as such", () => {
    renderPanel(fakeFind({ bookmarks: [bookmark("a", { preview: "" })] }));
    fireEvent.click(screen.getByRole("button", { name: "ブックマーク一覧（1件）" }));
    expect(screen.getByText("（本文なし）")).toBeTruthy();
  });
});

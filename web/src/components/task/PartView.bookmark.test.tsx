// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "@/lib/types";
import { PartView } from "./PartView";

const user: UiMessage = {
  id: "user-1",
  role: "user",
  createdAt: 1,
  parts: [{ id: "user-text", type: "text", text: "ログインを直して" }],
};

const assistant: UiMessage = {
  id: "assistant-1",
  role: "assistant",
  createdAt: 2,
  parts: [
    { id: "thought", type: "thinking", text: "考え中" },
    { id: "answer", type: "text", text: "原因は **設定** です" },
  ],
};

describe("PartView in-session search hooks", () => {
  afterEach(cleanup);

  it("marks conversation text as searchable and the article with its message id", () => {
    const { container } = render(<PartView message={user} taskId="task-1" />);
    expect(container.querySelector("article")?.getAttribute("data-message-id")).toBe("user-1");
    const searchable = container.querySelectorAll("[data-search-text]");
    expect(searchable).toHaveLength(1);
    expect(searchable[0]?.textContent).toBe("ログインを直して");
  });

  it("keeps assistant text searchable but not thinking, tool or meta text", () => {
    const { container } = render(<PartView message={assistant} taskId="task-1" />);
    const searchable = container.querySelectorAll("[data-search-text]");
    expect(searchable).toHaveLength(1);
    expect(searchable[0]?.textContent).toContain("原因は");
    expect(searchable[0]?.textContent).toContain("設定");
    expect(searchable[0]?.textContent).not.toContain("考え中");
  });

  it.each([
    ["user", user],
    ["assistant", assistant],
  ] as const)("shows a bookmark toggle under a %s message only when a handler is given", (_role, message) => {
    const { rerender } = render(<PartView message={message} taskId="task-1" />);
    expect(screen.queryByRole("button", { name: /ブックマーク/ })).toBeNull();

    const onToggle = vi.fn();
    rerender(<PartView message={message} taskId="task-1" onToggleBookmark={onToggle} />);
    const add = screen.getByRole("button", { name: "ブックマークに追加" });
    expect(add.textContent).toBe("ブックマーク");
    fireEvent.click(add);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(message);

    rerender(<PartView message={message} taskId="task-1" bookmarked onToggleBookmark={onToggle} />);
    const remove = screen.getByRole("button", { name: "ブックマークを外す" });
    expect(remove.textContent).toBe("ブックマーク済み");
    // It never sits in the meta row: that row's right edge is aligned to the bubble.
    const article = remove.closest("article")!;
    expect(article.firstElementChild?.contains(remove)).toBe(false);
  });

  it("joins the user's action row beside the existing buttons", () => {
    const onToggle = vi.fn();
    const onRevert = vi.fn();
    render(<PartView message={user} taskId="task-1" onRevert={onRevert} onToggleBookmark={onToggle} />);
    const row = screen.getByRole("button", { name: "ブックマークに追加" }).parentElement!;
    expect(row.textContent).toContain("入力欄に戻す");
    expect(row.textContent).toContain("ここから分岐");
    expect(row.lastElementChild?.getAttribute("aria-label")).toBe("ブックマークに追加");
  });

  it("offers a bookmark even where revert and fork are unavailable", () => {
    render(<PartView message={user} onToggleBookmark={vi.fn()} />);
    expect(screen.getByRole("button", { name: "ブックマークに追加" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ここから分岐" })).toBeNull();
  });

  it("puts an assistant message's toggle after its bubble", () => {
    render(<PartView message={assistant} taskId="task-1" onToggleBookmark={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "ブックマークに追加" });
    const article = toggle.closest("article")!;
    const bubble = article.querySelector("[data-search-text]")!;
    expect(bubble.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no toggle where the meta row is hidden or nested", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PartView message={assistant} taskId="task-1" hideMeta onToggleBookmark={onToggle} />);
    expect(screen.queryByRole("button", { name: /ブックマーク/ })).toBeNull();
    rerender(<PartView message={assistant} taskId="task-1" nested onToggleBookmark={onToggle} />);
    expect(screen.queryByRole("button", { name: /ブックマーク/ })).toBeNull();
    rerender(<PartView message={user} taskId="task-1" nested onToggleBookmark={onToggle} />);
    expect(screen.queryByRole("button", { name: /ブックマーク/ })).toBeNull();
  });

  it("re-renders when only the bookmark state changes", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PartView message={user} taskId="task-1" onToggleBookmark={onToggle} />);
    expect(screen.getByRole("button", { name: "ブックマークに追加" })).toBeTruthy();
    rerender(<PartView message={user} taskId="task-1" bookmarked onToggleBookmark={onToggle} />);
    expect(screen.getByRole("button", { name: "ブックマークを外す" })).toBeTruthy();
  });
});

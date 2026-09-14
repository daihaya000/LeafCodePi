// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BotIntercomInboxDto } from "@/lib/types";
import { BotIntercomInbox } from "./BotIntercomInbox";

const empty: BotIntercomInboxDto = { messages: [], unreadCount: 0, preview: null, pendingAsks: [] };
afterEach(() => cleanup());

it("shows a one-line who/what preview and an unread dot", () => {
  const inbox: BotIntercomInboxDto = {
    messages: [],
    unreadCount: 1,
    preview: { fromBotId: "alice", fromName: "Alice", text: "確認お願いします", createdAt: 1 },
    pendingAsks: [],
  };
  render(<BotIntercomInbox inbox={inbox} />);
  expect(screen.getByRole("region", { name: "内線受信箱" }).textContent).toContain("Alice: 確認お願いします");
  expect(screen.getByLabelText("未読")).toBeTruthy();
});

it("hides the unread dot when the inbox is empty", () => {
  render(<BotIntercomInbox inbox={empty} />);
  expect(screen.queryByLabelText("未読")).toBeNull();
  expect(screen.getByText("内線メッセージはありません")).toBeTruthy();
});

it("marks the inbox read from the 1:1 strip only", () => {
  const onRead = vi.fn();
  const inbox: BotIntercomInboxDto = {
    messages: [],
    unreadCount: 2,
    preview: { fromBotId: "alice", fromName: "Alice", text: "hello", createdAt: 1 },
    pendingAsks: [],
  };
  render(<BotIntercomInbox inbox={inbox} onRead={onRead} />);
  fireEvent.click(screen.getByRole("button", { name: "既読" }));
  expect(onRead).toHaveBeenCalledTimes(1);
});

it("shows the thread and an ask-waiting line on the same inbox", () => {
  const inbox: BotIntercomInboxDto = {
    messages: [
      {
        v: 1,
        id: "ask-1",
        fromBotId: "alice",
        fromName: "Alice",
        toBotId: "bob",
        text: "可否は？",
        createdAt: 1,
        depth: 0,
        kind: "ask",
        conversationId: "thread-1",
      },
    ],
    unreadCount: 1,
    preview: { fromBotId: "alice", fromName: "Alice", text: "可否は？", createdAt: 1, kind: "ask" },
    pendingAsks: [{
      id: "ask-1",
      conversationId: "thread-1",
      fromBotId: "alice",
      fromName: "Alice",
      text: "可否は？",
      createdAt: 1,
      expiresAt: 2,
    }],
  };
  render(<BotIntercomInbox inbox={inbox} />);
  expect(screen.getByLabelText("質問待ち").textContent).toContain("Alice");
  expect(screen.getByRole("list", { name: "内線スレッド" }).textContent).toContain("可否は？");
  expect(screen.getByRole("list", { name: "内線スレッド" }).textContent).toContain("質問");
});

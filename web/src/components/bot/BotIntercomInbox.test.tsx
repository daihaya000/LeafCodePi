// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { BotIntercomInboxDto } from "@/lib/types";
import { BotIntercomInbox } from "./BotIntercomInbox";

const empty: BotIntercomInboxDto = { messages: [], unreadCount: 0, preview: null };

it("shows a one-line who/what preview and an unread dot", () => {
  const inbox: BotIntercomInboxDto = {
    messages: [],
    unreadCount: 1,
    preview: { fromBotId: "alice", fromName: "Alice", text: "確認お願いします", createdAt: 1 },
  };
  render(<BotIntercomInbox inbox={inbox} />);
  expect(screen.getByRole("status", { name: "内線受信箱" }).textContent).toContain("Alice: 確認お願いします");
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
  };
  render(<BotIntercomInbox inbox={inbox} onRead={onRead} />);
  fireEvent.click(screen.getByRole("button", { name: "既読" }));
  expect(onRead).toHaveBeenCalledTimes(1);
});

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

it("renders nothing until a message arrives", () => {
  render(<BotIntercomInbox inbox={empty} />);
  expect(screen.queryByRole("region", { name: "内線受信箱" })).toBeNull();
});

it("hides the strip once every message is read", () => {
  const read: BotIntercomInboxDto = {
    messages: [{
      v: 1,
      id: "msg-1",
      fromBotId: "alice",
      fromName: "Alice",
      toBotId: "bob",
      text: "確認お願いします",
      createdAt: 1,
      depth: 0,
      kind: "send",
    }],
    unreadCount: 0,
    preview: { fromBotId: "alice", fromName: "Alice", text: "確認お願いします", createdAt: 1 },
    pendingAsks: [],
    peerPresence: { botId: "alice", name: "Alice", status: "online" },
  };
  render(<BotIntercomInbox inbox={read} />);
  expect(screen.queryByRole("region", { name: "内線受信箱" })).toBeNull();
});

it("keeps the strip while an inbound ask is unanswered", () => {
  const waiting: BotIntercomInboxDto = {
    ...empty,
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
  render(<BotIntercomInbox inbox={waiting} />);
  expect(screen.getByLabelText("質問待ち").textContent).toContain("Alice");
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

it("shows counterpart presence, attachments, and cancelled state", () => {
  const inbox: BotIntercomInboxDto = {
    messages: [
      {
        v: 1,
        id: "msg-1",
        fromBotId: "alice",
        fromName: "Alice",
        toBotId: "bob",
        text: "差し替え前",
        createdAt: 1,
        depth: 0,
        kind: "send",
        cancelled: true,
        delivery: "cancelled",
      },
      {
        v: 1,
        id: "msg-2",
        fromBotId: "alice",
        fromName: "Alice",
        toBotId: "bob",
        text: "画像です",
        createdAt: 2,
        depth: 0,
        kind: "send",
        delivery: "steered",
        attachments: [{ kind: "image", name: "image-1.png", mimeType: "image/png", file: "msg-2-0.png", bytes: 12 }],
      },
    ],
    unreadCount: 1,
    preview: { fromBotId: "alice", fromName: "Alice", text: "画像です", createdAt: 2 },
    pendingAsks: [],
    peerPresence: { botId: "alice", name: "Alice", status: "busy" },
  };
  render(<BotIntercomInbox inbox={inbox} />);
  const presence = screen.getByLabelText("在席 取り込み中");
  expect(presence.getAttribute("title")).toBe("取り込み中");
  expect(screen.getByRole("region", { name: "内線受信箱" }).textContent).toContain("Alice: 画像です");
  expect(screen.getByRole("region", { name: "内線受信箱" }).textContent).not.toContain("取り込み中");
  expect(screen.getByLabelText("添付 image-1.png")).toBeTruthy();
  expect(screen.getByRole("list", { name: "内線スレッド" }).textContent).toContain("取消");
  expect(screen.queryByText("詳細")).toBeNull();
  expect(screen.getByTitle("msg-2 · steered · depth 0")).toBeTruthy();
});

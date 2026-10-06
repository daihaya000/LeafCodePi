// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary, UiMessage } from "@/lib/types";
import { COMPACTION_ACTION_SETTING_KEY } from "@/lib/compaction-settings";
import { setNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  apiUrl: (path: string) => path,
  partView: vi.fn(),
  toolCard: vi.fn(),
  messageMetaHeader: vi.fn(),
  workingRow: vi.fn(() => null),
  markRead: vi.fn(),
  botFor: vi.fn(),
  iconFor: vi.fn(),
}));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/lib/bot-unread", () => ({ markRead: mocks.markRead }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({
  PartView: mocks.partView,
  ToolCard: mocks.toolCard,
  MessageMetaHeader: mocks.messageMetaHeader,
  WorkingRow: mocks.workingRow,
}));
vi.mock("@/components/task/ProjectExplorerButton", () => ({ ProjectExplorerButton: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useBotFor: () => mocks.botFor, useIconFor: () => mocks.iconFor }));

import { TaskView } from "./TaskView";
import { clearCachedModels } from "@/lib/models-cache";

const task: TaskSummary = {
  id: "find-task", projectId: null, projectName: "test", title: "find test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const bookmarksPath = `/api/tasks/${task.id}/bookmarks`;
const searchPath = `/api/tasks/${task.id}/search`;
const messagesPath = `/api/tasks/${encodeURIComponent(task.id)}/messages`;

function text(id: string, role: "user" | "assistant", body: string, createdAt = 1): UiMessage {
  return { id, role, createdAt, parts: [{ id: `${id}-text`, type: "text", text: body }] };
}

/** A stand-in for PartView that keeps what the search code relies on: the article id, searchable text and the toggle. */
function fakePartView({ message, bookmarked, onToggleBookmark }: {
  message: UiMessage;
  bookmarked?: boolean;
  onToggleBookmark?: (message: UiMessage) => void;
}) {
  const body = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return (
    <article data-message-id={message.id}>
      <div data-search-text>{body}</div>
      {onToggleBookmark && (
        <button type="button" onClick={() => onToggleBookmark(message)}>
          {bookmarked ? `marked ${message.id}` : `mark ${message.id}`}
        </button>
      )}
    </article>
  );
}

function stubPayloads(extra: (path: string, params?: Record<string, string>) => unknown | undefined = () => undefined) {
  mocks.getJson.mockImplementation((path: string, params?: Record<string, string>) => {
    const custom = extra(path, params);
    if (custom !== undefined) return Promise.resolve(custom);
    if (path === `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`) return Promise.resolve({ value: "suggest" });
    if (path === "/api/settings/tts") return Promise.resolve({ enabled: true });
    return Promise.resolve({ models: [], agents: [], skills: [], accounts: [] });
  });
}

class TestEventSource extends EventTarget {
  static latest: TestEventSource | null = null;
  constructor() {
    super();
    TestEventSource.latest = this;
  }
  close() {}
}

beforeEach(() => {
  setNotificationDeliveryEnabled(true);
  localStorage.clear();
  clearCachedModels();
  vi.clearAllMocks();
  mocks.partView.mockImplementation(fakePartView);
  mocks.toolCard.mockReturnValue(null);
  mocks.messageMetaHeader.mockReturnValue(null);
  mocks.botFor.mockReset();
  mocks.iconFor.mockReset().mockReturnValue(null);
  vi.stubGlobal("EventSource", TestEventSource);
  // happy-dom has no layout: give every element a box (isRendered itself excludes a closed <details>' content).
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ width: 10, height: 10 }] as unknown as DOMRectList);
  stubPayloads();
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  clearCachedModels();
  TestEventSource.latest = null;
});

const searchButtons = () => screen.getAllByRole("button", { name: "セッション内を検索" });

describe("TaskView in-session search", () => {
  it("opens from the header button, toggles shut and answers Ctrl+F and Esc", async () => {
    render(<TaskView taskId={task.id} mdUp />);
    expect(screen.queryByRole("search", { name: "セッション内検索" })).toBeNull();

    fireEvent.click(searchButtons()[0]!);
    expect(screen.getByRole("search", { name: "セッション内検索" })).toBeTruthy();
    expect(searchButtons()[0]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(searchButtons()[0]!);
    expect(screen.queryByRole("search", { name: "セッション内検索" })).toBeNull();

    // Ctrl+F from the page itself goes to the lone pane; Esc inside the panel closes it again.
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    const box = await screen.findByRole("searchbox", { name: "セッション内を検索" });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "セッション内検索" })).toBeNull();
  });

  it("closes the graph or diff panel that would cover the timeline on a narrow screen", () => {
    render(<TaskView taskId={task.id} mdUp={false} />);
    fireEvent.click(screen.getByRole("button", { name: "コミットグラフ" }));
    expect(screen.getByRole("button", { name: "コミットグラフ" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(searchButtons()[0]!);
    expect(screen.getByRole("search", { name: "セッション内検索" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "コミットグラフ" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("labels each timeline row with the messages it renders", () => {
    const toolMessage: UiMessage = {
      id: "tool-1", role: "assistant", createdAt: 2,
      parts: [{ id: "tool-1-part", type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: {} } }],
    };
    const toolMessage2: UiMessage = {
      id: "tool-2", role: "assistant", createdAt: 3,
      parts: [{ id: "tool-2-part", type: "tool", tool: "grep", callID: "c2", state: { status: "completed", input: {} } }],
    };
    saveTaskSessionCache({
      task,
      messages: [text("user-1", "user", "指示"), toolMessage, toolMessage2, text("reply-1", "assistant", "完了", 4)],
      isStreaming: false,
      isCompacting: false,
    });
    const { container } = render(<TaskView taskId={task.id} mdUp />);
    const rows = [...container.querySelectorAll("[data-message-ids]")].map((row) => row.getAttribute("data-message-ids"));
    expect(rows).toEqual(["user-1", "tool-1 tool-2", "reply-1"]);
  });

  it("jumps to a hit in older history by paging it in, then marks the row", async () => {
    const recent = text("recent", "assistant", "最近の返信", 20);
    const older = text("older", "assistant", "古い needle の話", 10);
    saveTaskSessionCache({
      task, messages: [recent], isStreaming: false, isCompacting: false,
      messageHistory: { hasMore: true, nextCursor: "recent" },
    });
    stubPayloads((path, params) => {
      if (path === messagesPath && params?.before === "recent") {
        return { messages: [older], messageHistory: { hasMore: false, nextCursor: null } };
      }
      if (path === searchPath) {
        return {
          terms: ["needle"], total: 1, truncated: false,
          hits: [{ messageId: "older", role: "assistant", createdAt: 10, snippet: "古い needle の話", highlights: [[2, 8]], count: 1 }],
        };
      }
      return undefined;
    });
    const { container } = render(<TaskView taskId={task.id} mdUp />);
    expect(container.querySelector('[data-message-ids="older"]')).toBeNull();

    fireEvent.click(searchButtons()[0]!);
    fireEvent.change(await screen.findByRole("searchbox", { name: "セッション内を検索" }), { target: { value: "needle" } });

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith(messagesPath, { before: "recent" }));
    await waitFor(() => expect(container.querySelector('[data-message-ids="older"]')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('[data-message-ids="older"]')?.hasAttribute("data-find-active")).toBe(true));
    // The older message is now part of the timeline, ahead of the recent one.
    const order = [...container.querySelectorAll("[data-message-ids]")].map((row) => row.getAttribute("data-message-ids"));
    expect(order).toEqual(["older", "recent"]);
  });

  it("opens a collapsed work log that holds the bookmarked message", async () => {
    const tool = (id: string, createdAt: number, body: string): UiMessage => ({
      id, role: "assistant", createdAt,
      parts: [
        { id: `${id}-tool`, type: "tool", tool: "read", callID: id, state: { status: "completed", input: {} } },
        { id: `${id}-text`, type: "text", text: body },
      ],
    });
    saveTaskSessionCache({
      task,
      messages: [text("user-1", "user", "指示"), tool("step-1", 2, "ファイルを読みます"), tool("step-2", 3, "次を直します")],
      isStreaming: false,
      isCompacting: false,
    });
    stubPayloads((path) => path === bookmarksPath
      ? { bookmarks: [{ messageId: "step-2", role: "assistant", messageCreatedAt: 3, createdAt: 9, preview: "次を直します" }] }
      : undefined);
    const { container } = render(<TaskView taskId={task.id} mdUp />);
    const log = container.querySelector("details[data-task-tool-group]") as HTMLDetailsElement;
    expect(log).not.toBeNull();
    expect(log.hasAttribute("open")).toBe(false);

    fireEvent.click(searchButtons()[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "ブックマーク一覧（1件）" }));
    fireEvent.click(screen.getByRole("button", { name: /次を直します/ }));

    await waitFor(() => expect(log.hasAttribute("open")).toBe(true));
  });
});

describe("TaskView message bookmarks", () => {
  it("hands each message its bookmark state and saves a toggle", async () => {
    saveTaskSessionCache({
      task,
      messages: [text("user-1", "user", "指示"), text("reply-1", "assistant", "返信", 2)],
      isStreaming: false,
      isCompacting: false,
    });
    stubPayloads((path) => path === bookmarksPath
      ? { bookmarks: [{ messageId: "reply-1", role: "assistant", messageCreatedAt: 2, createdAt: 9, preview: "返信" }] }
      : undefined);
    mocks.sendJson.mockResolvedValue({
      bookmarks: [
        { messageId: "user-1", role: "user", messageCreatedAt: 1, createdAt: 10, preview: "指示" },
        { messageId: "reply-1", role: "assistant", messageCreatedAt: 2, createdAt: 9, preview: "返信" },
      ],
    });
    render(<TaskView taskId={task.id} mdUp />);

    expect(await screen.findByRole("button", { name: "marked reply-1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "mark user-1" }));

    expect(mocks.sendJson).toHaveBeenCalledExactlyOnceWith(
      bookmarksPath,
      { messageId: "user-1", role: "user", messageCreatedAt: 1, preview: "指示" },
      "PUT",
    );
    expect(await screen.findByRole("button", { name: "marked user-1" })).toBeTruthy();
  });

  it("offers no bookmark for a message that is not persisted yet", () => {
    saveTaskSessionCache({
      task,
      messages: [text("user-1", "user", "指示"), text("msg-7", "assistant", "生成中の返信", 2)],
      isStreaming: false,
      isCompacting: false,
    });
    render(<TaskView taskId={task.id} mdUp />);
    expect(screen.getByRole("button", { name: "mark user-1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /msg-7/ })).toBeNull();
  });

  it("does not fetch bookmarks for a hidden tab", async () => {
    render(<TaskView taskId={task.id} mdUp active={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.getJson.mock.calls.some(([path]) => path === bookmarksPath)).toBe(false);
  });
});

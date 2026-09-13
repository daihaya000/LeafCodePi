// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary, UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({
  PartView: () => null,
  MessageMetaHeader: () => null,
  WorkingRow: () => null,
}));
vi.mock("@/components/task/ProjectExplorerButton", () => ({ ProjectExplorerButton: () => null }));

import { TaskView } from "./TaskView";

const task: TaskSummary = {
  id: "resume-task", projectId: null, projectName: "test", title: "resume test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: "session-1", sessionFile: "session.jsonl",
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TaskView resume payload", () => {
  it("keeps the account of the interrupted assistant turn", async () => {
    let latest: EventTarget | null = null;
    class TestEventSource extends EventTarget {
      constructor() {
        super();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latest = this;
      }

      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);

    const messages: UiMessage[] = [
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        parts: [{ id: "u1-text", type: "text", text: "元のプロンプト" }],
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: 2,
        provider: "anthropic",
        model: "claude-sonnet",
        accountId: "acc-1",
        error: "Aborted",
        parts: [],
      },
    ];
    saveTaskSessionCache({ task, messages, isStreaming: false, isCompacting: false });
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    if (!latest) throw new Error("EventSource was not created");

    await act(async () => {
      latest!.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task,
          messages,
          manualAbortedAssistantId: "a1",
        }),
      }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "中断したターンを再開" }));

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`,
      expect.objectContaining({
        model: "acc-1::anthropic::claude-sonnet",
        resume: true,
      }),
    ));
  });

  it("does not let a stale history request unlock a newer page load", async () => {
    let latest: EventTarget | null = null;
    class TestEventSource extends EventTarget {
      constructor() {
        super();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latest = this;
      }

      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    type HistoryPage = {
      messages: UiMessage[];
      messageHistory: { hasMore: boolean; nextCursor: string | null };
    };
    const pending: ((page: HistoryPage) => void)[] = [];
    mocks.getJson.mockImplementation((url: string) => {
      if (url.endsWith("/messages")) {
        return new Promise<HistoryPage>((resolve) => pending.push(resolve));
      }
      if (url === "/api/models") return Promise.resolve({ models: [] });
      if (url === "/api/agents") return Promise.resolve({ agents: [] });
      if (url === "/api/skills") return Promise.resolve({ skills: [] });
      return Promise.resolve({});
    });
    const first = {
      id: "history-1",
      role: "user" as const,
      createdAt: 1,
      parts: [{ id: "history-1-text", type: "text" as const, text: "old" }],
    };
    const second = { ...first, id: "history-2", parts: [{ ...first.parts[0], id: "history-2-text" }] };
    render(<TaskView taskId={task.id} mdUp />);
    if (!latest) throw new Error("EventSource was not created");

    await act(async () => {
      latest!.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task,
          messages: [{ ...first, id: "tail", parts: [{ ...first.parts[0], id: "tail-text", text: "tail" }] }],
          messageHistory: { hasMore: true, nextCursor: "cursor-1" },
        }),
      }));
    });
    const loadButton = await screen.findByRole("button", { name: "過去の履歴を読み込む" });
    fireEvent.click(loadButton);
    expect(pending).toHaveLength(1);

    await act(async () => {
      latest!.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "conversation_reset",
          task,
          messages: [],
          messageHistory: { hasMore: true, nextCursor: "cursor-2" },
        }),
      }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "過去の履歴を読み込む" }));
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[0]?.({ messages: [first], messageHistory: { hasMore: true, nextCursor: "cursor-0" } });
      await Promise.resolve();
    });
    const viewport = document.querySelector<HTMLElement>(".bg-bot-chat");
    if (!viewport) throw new Error("Conversation viewport was not rendered");
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 0 });
    fireEvent.scroll(viewport);
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1]?.({ messages: [second], messageHistory: { hasMore: false, nextCursor: null } });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "過去の履歴を読み込み中…" })).toBeNull());
  });
});

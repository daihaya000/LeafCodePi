// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_ACTION_SETTING_KEY } from "@/lib/compaction-settings";
import type { TaskSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), botFor: vi.fn(), iconFor: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("@/lib/bot-unread", () => ({ markRead: vi.fn() }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({
  PartView: ({ message }: { message: { parts: Array<{ text?: string }> } }) => <span>{message.parts.map(p => p.text).join("")}</span>,
  ToolCard: () => null,
  MessageMetaHeader: () => null,
  WorkingRow: () => null,
}));
vi.mock("@/components/task/ProjectExplorerButton", () => ({ ProjectExplorerButton: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({
  useBotFor: () => mocks.botFor,
  useIconFor: () => mocks.iconFor,
}));

import { TaskView } from "./TaskView";
import { clearCachedModels } from "@/lib/models-cache";
import { saveTaskSessionCache } from "@/lib/task-session-cache";

const task: TaskSummary = {
  id: "task-1", projectId: null, projectName: "test", title: "test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

let opened = 0;
let sources: Array<EventTarget & { url: string }> = [];

beforeEach(() => {
  localStorage.clear();
  clearCachedModels();
  mocks.botFor.mockReturnValue(undefined);
  mocks.iconFor.mockReturnValue(undefined);
  opened = 0;
  sources = [];
  class TestEventSource extends EventTarget {
    constructor(public url: string) {
      super();
      opened += 1;
      sources.push(this);
    }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource as unknown as typeof EventSource);
  mocks.getJson.mockImplementation((path: string) =>
    path === `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`
      ? Promise.resolve({ value: "suggest" })
      : path === "/api/settings/tts"
        ? Promise.resolve({ enabled: false })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
  );
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TaskView SSE visibility", () => {
  it("does not advertise an empty cached transcript and can force a fresh history request", async () => {
    const sessionTask = { ...task, sessionId: "session", sessionFile: "session.jsonl" };
    saveTaskSessionCache({ task: sessionTask, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => expect(sources.length).toBe(1));
    expect(sources[0].url).not.toContain("cachedSessionId");
    await act(async () => {
      sources[0].dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task: sessionTask, messages: [], isStreaming: false, eventType: "ready" }) }));
    });
    fireEvent.click(screen.getByRole("button", { name: "履歴を再読み込み" }));
    await waitFor(() => expect(sources.length).toBe(2));
    expect(sources[1].url).not.toContain("cachedSessionId");
  });

  it("does not save a metadata-only background ready as empty history, and loads the transcript on visibility", async () => {
    localStorage.clear();
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    try {
      render(<TaskView taskId={task.id} mdUp />);
      await waitFor(() => expect(sources.length).toBe(1));
      expect(sources[0].url).toContain("streamMessages=0");
      const sessionTask = { ...task, sessionId: "session", sessionFile: "session.jsonl" };
      await act(async () => {
        sources[0].dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task: sessionTask, isStreaming: false, eventType: "bootstrap" }) }));
        sources[0].dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task: sessionTask, isStreaming: false, todos: [{ id: "1", content: "done", status: "completed", priority: "high" }], eventType: "ready" }) }));
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(localStorage.getItem("webui:task-session-cache")).toBeNull();
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(sources.length).toBe(2));
      expect(sources[1].url).toContain("streamMessages=1");
      expect(sources[1].url).not.toContain("cachedSessionId");
      const messages = [{ id: "real", role: "assistant", createdAt: 1, parts: [{ id: "text", type: "text", text: "restored transcript" }] }];
      await act(async () => {
        sources[1].dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task: sessionTask, messages, isStreaming: false, messageHistory: { hasMore: true, nextCursor: "real" }, eventType: "ready" }) }));
      });
      expect(screen.getByText("restored transcript")).toBeTruthy();
      await act(async () => { window.dispatchEvent(new Event("pagehide")); });
      const stored = JSON.parse(localStorage.getItem("webui:task-session-cache")!);
      expect(stored.entries[task.id].messages).toEqual(messages);
    } finally {
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
    }
  });

  it("does not connect while the pane is in the background", async () => {
    render(<TaskView taskId={task.id} mdUp={false} active={false} />);

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(opened).toBe(0);
  });

  it("connects once the pane becomes visible", async () => {
    const { rerender } = render(<TaskView taskId={task.id} mdUp={false} active={false} />);
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(opened).toBe(0);

    rerender(<TaskView taskId={task.id} mdUp={false} active />);

    await waitFor(() => expect(opened).toBe(1));
  });
});
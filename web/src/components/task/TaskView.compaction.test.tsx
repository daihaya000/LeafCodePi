// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
let sources: Array<EventTarget & { url: string; close: ReturnType<typeof vi.fn> }> = [];
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
  id: "compaction-task", projectId: null, projectName: "test", title: "compaction test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: "session-1", sessionFile: "session.jsonl",
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  sources = [];
  class TestEventSource extends EventTarget {
    close = vi.fn();
    constructor(public url: string) { super(); sources.push(this); }
  }
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  mocks.sendJson.mockResolvedValue({ task });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TaskView manual compaction", () => {
  it("reconnects without history after a cold failure, keeps compression usable, and retries normal history", async () => {
    render(<TaskView taskId={task.id} mdUp />);
    await act(async () => { await Promise.resolve(); });
    const first = sources[0];
    await act(async () => {
      first.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task, messages: [], isStreaming: false, isCompacting: false, eventType: "bootstrap" }) }));
      first.dispatchEvent(new MessageEvent("error", { data: JSON.stringify({ error: "bounded history", code: "COLD_TRANSCRIPT_UNAVAILABLE" }) }));
    });
    fireEvent.click(screen.getByRole("button", { name: "履歴を読み込まずに再接続" }));
    await waitFor(() => expect(sources.length).toBe(2));
    expect(first.close).toHaveBeenCalled();
    expect(sources[1].url).toContain("history=omit");
    expect(sources[1].url).not.toContain("cachedSessionId");
    await act(async () => {
      sources[1].dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task, messages: [], messageHistory: { hasMore: false, nextCursor: null }, historyReset: true, isStreaming: false, isCompacting: false, eventType: "ready" }) }));
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "コンテキスト圧縮" }).disabled).toBe(false);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(localStorage.getItem("webui:task-session-cache")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "履歴表示を再試行" }));
    await waitFor(() => expect(sources.length).toBe(3));
    expect(sources[2].url).not.toContain("history=omit");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(localStorage.getItem("webui:task-session-cache")).toBeNull();
  });

  it("does not offer transcript recovery for unrelated fatal errors", async () => {
    render(<TaskView taskId={task.id} mdUp />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      sources[0].dispatchEvent(new MessageEvent("error", { data: JSON.stringify({ error: "not found" }) }));
    });
    expect(screen.getByRole("alert").textContent).toContain("not found");
    expect(screen.queryByRole("button", { name: "履歴を読み込まずに再接続" })).toBeNull();
  });

  it.each(["auto", "suggest", "off", "unavailable"])("shows the button with compaction setting %s", async (setting) => {
    mocks.getJson.mockImplementation((url: string) => {
      if (url === "/api/settings/compactionAction") {
        return setting === "unavailable" ? Promise.reject(new Error("offline")) : Promise.resolve({ value: setting });
      }
      return Promise.resolve({ models: [], agents: [], skills: [], accounts: [] });
    });
    saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp />);
    await act(async () => { await Promise.resolve(); });

    const button = screen.getByRole<HTMLButtonElement>("button", { name: "コンテキスト圧縮" });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/compact`, {}, "POST", { timeoutMs: 240_000 },
    ));
  });

  it.each([
    { status: "working" as const, isStreaming: true, isCompacting: false },
    { status: "idle" as const, isStreaming: false, isCompacting: true },
    { status: "archived" as const, isStreaming: false, isCompacting: false },
  ])("keeps the button visible but disabled for $status / compacting=$isCompacting", async (state) => {
    saveTaskSessionCache({ task: { ...task, status: state.status }, messages: [], ...state });
    render(<TaskView taskId={task.id} mdUp />);
    await act(async () => { await Promise.resolve(); });

    const button = screen.getByRole<HTMLButtonElement>("button", { name: "コンテキスト圧縮" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.sendJson).not.toHaveBeenCalled();
  });
});

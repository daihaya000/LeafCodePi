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
});

// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary, UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  partView: vi.fn(),
  workingRow: vi.fn(),
  botFor: vi.fn(),
}));

vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useBotFor: () => mocks.botFor }));
vi.mock("@/components/task/PartView", async () => {
  const { memo } = await import("react");
  const PartView = memo(function TestPartView({ message }: { message: UiMessage }) {
    mocks.partView(message.id);
    return null;
  });
  return {
    PartView,
    ToolCard: () => null,
    MessageMetaHeader: () => null,
    WorkingRow: () => {
      mocks.workingRow();
      return null;
    },
  };
});

import { TaskView } from "./TaskView";

const task: TaskSummary = {
  id: "render-task",
  projectId: null,
  projectName: "test",
  title: "render test",
  directory: "",
  isolation: "current_folder",
  status: "idle",
  sessionId: null,
  sessionFile: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  mocks.botFor.mockReturnValue(undefined);
  saveTaskSessionCache({
    task,
    messages: [],
    isStreaming: false,
    isCompacting: false,
  });
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TaskView render stability", () => {
  it("does not rerender unchanged assistant rows when an SSE delta changes task status", async () => {
    const message: UiMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt: 1,
      parts: [{ id: "assistant-1-text", type: "text", text: "応答" }],
    };
    saveTaskSessionCache({ task, messages: [message], isStreaming: false, isCompacting: false });

    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;

      constructor() {
        super();
        TestEventSource.latest = this;
      }

      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);

    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => expect(mocks.partView).toHaveBeenCalledWith(message.id));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    mocks.partView.mockClear();

    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");
    await act(async () => {
      source.dispatchEvent(new MessageEvent("delta", {
        data: JSON.stringify({
          task: { ...task, status: "working" },
          isStreaming: true,
        }),
      }));
    });

    await waitFor(() => expect(mocks.workingRow).toHaveBeenCalled());
    expect(mocks.partView).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_ACTION_SETTING_KEY } from "@/lib/compaction-settings";
import type { TaskSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), botFor: vi.fn(), iconFor: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("@/lib/bot-unread", () => ({ markRead: vi.fn() }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({
  PartView: () => null,
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

beforeEach(() => {
  localStorage.clear();
  clearCachedModels();
  mocks.botFor.mockReturnValue(undefined);
  mocks.iconFor.mockReturnValue(undefined);
  opened = 0;
  class TestEventSource extends EventTarget {
    constructor() {
      super();
      opened += 1;
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
  it("does not connect while the pane is in the background", async () => {
    render(<TaskView taskId={task.id} task={task} active={false} />);

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(opened).toBe(0);
  });

  it("connects once the pane becomes visible", async () => {
    const { rerender } = render(<TaskView taskId={task.id} task={task} active={false} />);
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(opened).toBe(0);

    rerender(<TaskView taskId={task.id} task={task} active />);

    await waitFor(() => expect(opened).toBe(1));
  });
});
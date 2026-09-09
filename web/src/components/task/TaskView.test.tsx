// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({ PartView: () => null, WorkingRow: () => null }));

import { TaskView } from "./TaskView";

const task: TaskSummary = {
  id: "draft-task", projectId: null, projectName: "test", title: "draft test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TaskView draft submission", () => {
  it("hides the manual context compaction control from the header", () => {
    render(<TaskView taskId={task.id} mdUp />);

    expect(screen.queryByRole("button", { name: "コンテキスト圧縮" })).toBeNull();
  });

  it.each(["success", "failure"])("sends queued content without replacing the next draft (%s)", async (outcome) => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    if (outcome === "failure") mocks.sendJson.mockRejectedValue(new Error("queue failed"));
    else mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    const snapshot = async (working: boolean) => {
      await act(async () => {
        TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({ eventType: "ready", task: { ...task, status: working ? "working" : "idle", isStreaming: working }, messages: [] }),
        }));
      });
    };
    await snapshot(true);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "queued prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "unfinished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "割り込み" }));
    expect(screen.getByRole("button", { name: "割り込みを送信" })).toBeTruthy();
    await snapshot(false);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "queued prompt" }),
    ));
    expect(input.value).toBe("unfinished draft");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBeUndefined();
    if (outcome === "failure") {
      expect(await screen.findByText("queue failed")).toBeTruthy();
      expect(screen.getByText("queued prompt")).toBeTruthy();
    }
  });
  it.each([false, true])("uses steer only while working (working: %s)", async (working) => {
    saveTaskSessionCache({ task: { ...task, status: working ? "working" : "idle" }, messages: [], isStreaming: working, isCompacting: false });
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "割り込み" }));
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "instruction" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(1));
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBe(working ? "steer" : undefined);
  });

  it("refreshes worktree status when a task mutation is reported", async () => {
    const worktreeTask = { ...task, directory: "C:\\repo" };
    let changed = 1;
    saveTaskSessionCache({ task: worktreeTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockImplementation((path: string) =>
      path === "/api/diff/files"
        ? Promise.resolve({ git: true, count: changed, files: [] })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
    );
    render(<TaskView taskId={task.id} mdUp />);
    expect((await screen.findAllByText("変更あり")).length).toBe(2);

    changed = 0;
    await act(async () => {
      window.dispatchEvent(new Event("webui:tasks-changed"));
      await Promise.resolve();
    });
    expect((await screen.findAllByText("クリーン")).length).toBe(2);
  });

  it("switches Graph and Diff instead of opening both when the timeline is narrow", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = originalGetBoundingClientRect.call(this);
      return { ...rect, width: 800, right: rect.left + 800 } as DOMRect;
    });

    try {
      render(<TaskView taskId={task.id} mdUp />);
      const graph = screen.getByRole("button", { name: "コミットグラフ" });
      const diff = screen.getByRole("button", { name: "Diff パネル" });
      fireEvent.click(graph);
      fireEvent.click(diff);

      expect(graph.getAttribute("aria-pressed")).toBe("false");
      expect(diff.getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves a new draft while starting a goal loop", async () => {
    let resolve!: (value: unknown) => void;
    mocks.sendJson.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "goal" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "next draft" } });
    await act(async () => { resolve({ loop: null }); });
    expect(input.value).toBe("next draft");
  });

  it.each([false, true])("restores an untouched draft after failure (goal loop: %s)", async (goalLoop) => {
    mocks.sendJson.mockRejectedValue(new Error("request failed"));
    render(<TaskView taskId={task.id} mdUp />);
    if (goalLoop) fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "retry this" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await screen.findByText("request failed");
    expect(input.value).toBe("retry this");
  });

  it.each(["success", "failure"])("preserves text and attachments entered during a pending %s", async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mocks.sendJson.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const { container } = render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "first prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "first prompt" }),
    ));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "next draft" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "next.png", { type: "image/png" })] },
    });
    await screen.findByRole("img", { name: "next.png" });
    await act(async () => {
      if (outcome === "success") resolve({ task });
      else reject(new Error("request failed"));
    });
    expect(input.value).toBe("next draft");
    expect(screen.getByRole("img", { name: "next.png" })).toBeTruthy();
  });

  it("keeps permission actions available when the message is long", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;

      constructor() {
        super();
        TestEventSource.latest = this;
      }

      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({ advice: "" });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const message = Array.from({ length: 100 }, (_, index) => `安全ガード ${index}`).join("\n");
    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
          messages: [],
          permissionRequest: {
            id: "request-1",
            sessionId: "session-1",
            command: "echo test",
            labels: ["os"],
            message,
          },
        }),
      }));
    });

    const dialog = await screen.findByRole("alertdialog", { name: "危険なコマンドの確認" });
    const messageNode = dialog.querySelector("p");
    expect(messageNode?.className).toContain("max-h-32");
    expect(messageNode?.className).toContain("overflow-auto");
    expect(screen.getByRole("button", { name: "許可" })).toBeTruthy();
  });

  it("clears goal loop state when a snapshot explicitly sends null", async () => {
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
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const goalLoop = {
      id: "session-1",
      sessionId: "session-1",
      cwd: "",
      status: "paused",
      goal: "keep going",
      acceptance: ["done"],
      maxTurns: 3,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: false,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "user",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      unreadableStreak: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const sendSnapshot = async (payload: unknown) => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(payload) }));
      });
    };

    await sendSnapshot({
      eventType: "ready",
      task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
      messages: [],
      goalLoop,
    });
    expect(await screen.findByRole("region", { name: "Goal loop" })).toBeTruthy();

    await sendSnapshot({
      eventType: "restored",
      task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
      messages: [],
      goalLoop: null,
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Goal loop" })).toBeNull());
  });
});

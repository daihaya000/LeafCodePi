// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  playAttentionRequiredSound: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("@/lib/session-complete-sound", () => ({
  playAttentionRequiredSound: mocks.playAttentionRequiredSound,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => window.location.pathname,
}));

import { GlobalAttentionProvider } from "./GlobalAttentionProvider";

const taskDetail = (taskId: string) => ({
  id: taskId,
  projectId: "p1",
  projectName: "プロジェクト",
  title: "タスク",
  directory: "C:\\repo",
  isolation: "current_folder",
  status: "working",
  sessionId: null,
  sessionFile: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  error: null,
  messages: [],
  isStreaming: true,
  isCompacting: false,
  todos: [],
});

describe("GlobalAttentionProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.pushState({}, "", "/");
    mocks.getJson.mockReset();
    mocks.sendJson.mockReset();
    mocks.playAttentionRequiredSound.mockReset();
    mocks.sendJson.mockResolvedValue({ advice: "" });
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return { attention: [{ taskId: "task-a", title: "タスクA", kinds: ["permission"] }] };
      }
      if (path === "/api/tasks/task-a") {
        return { task: taskDetail("task-a") };
      }
      throw new Error(`unexpected: ${path}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not auto-open when the fresh attention is only for the active task", async () => {
    window.history.pushState({}, "", "/task/task-a");
    render(<GlobalAttentionProvider />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event("focusout"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.playAttentionRequiredSound).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").not.toMatch(/承認・回答が必要です/);
  });

  it("auto-opens as soon as another task needs attention", async () => {
    render(<GlobalAttentionProvider />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.playAttentionRequiredSound).toHaveBeenCalled();
    expect(document.body.textContent ?? "").toMatch(/承認・回答が必要です/);
  });

  it("waits for focusout before opening while an input is focused", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    render(<GlobalAttentionProvider />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").not.toMatch(/承認・回答が必要です/);

    await act(async () => {
      input.blur();
      window.dispatchEvent(new Event("focusout"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").toMatch(/承認・回答が必要です/);
    input.remove();
  });

  it("does not refetch task details when the attention list is unchanged", async () => {
    render(<GlobalAttentionProvider />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    const detailCalls = () =>
      mocks.getJson.mock.calls.filter(([path]) => path === "/api/tasks/task-a");
    expect(detailCalls().length).toBe(1);

    // Second poll: same attention list → no refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(detailCalls().length).toBe(1);
  });

  it("refetches details when a new attention kind appears", async () => {
    render(<GlobalAttentionProvider />);

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    await act(async () => {
      window.dispatchEvent(new Event("focusout"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Attention list grows with a new kind → state updates → details refetched.
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return {
          attention: [
            { taskId: "task-a", title: "タスクA", kinds: ["permission", "question"] },
          ],
        };
      }
      if (path === "/api/tasks/task-a") {
        return { task: taskDetail("task-a") };
      }
      throw new Error(`unexpected: ${path}`);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
    });

    const detailCalls = mocks.getJson.mock.calls.filter(
      ([path]) => path === "/api/tasks/task-a",
    );
    expect(detailCalls.length).toBe(2);
  });

  it("does not duplicate the active task permission UI when another task also needs attention", async () => {
    window.history.pushState({}, "", "/task/task-a");
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return {
          attention: [
            { taskId: "task-a", title: "タスクA", kinds: ["permission"] },
            { taskId: "task-b", title: "タスクB", kinds: ["permission"] },
          ],
        };
      }
      if (path === "/api/tasks/task-a") {
        return {
          task: {
            ...taskDetail("task-a"),
            title: "タスクA",
            permissionRequest: {
              id: "req-a",
              sessionId: "sess-a",
              message: "Aを許可しますか",
              command: "Stop-Computer -Force",
              labels: ["os"],
            },
          },
        };
      }
      if (path === "/api/tasks/task-b") {
        return {
          task: {
            ...taskDetail("task-b"),
            title: "タスクB",
            permissionRequest: {
              id: "req-b",
              sessionId: "sess-b",
              message: "Bを許可しますか",
              command: "echo b",
              labels: [],
            },
          },
        };
      }
      throw new Error(`unexpected: ${path}`);
    });

    render(<GlobalAttentionProvider />);

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    await act(async () => {
      window.dispatchEvent(new Event("focusout"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    const body = document.body.textContent ?? "";
    expect(body).toMatch(/承認・回答が必要です/);
    expect(body).toMatch(/Bを許可しますか/);
    expect(body).toMatch(/このタスクの画面で応答できます/);
    expect(body).not.toMatch(/Aを許可しますか/);
    expect(mocks.playAttentionRequiredSound).toHaveBeenCalled();
  });
});

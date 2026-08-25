// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  playAttentionRequiredSound: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson }));
vi.mock("@/lib/session-complete-sound", () => ({
  playAttentionRequiredSound: mocks.playAttentionRequiredSound,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
    mocks.getJson.mockReset();
    mocks.playAttentionRequiredSound.mockReset();
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

  it("does not refetch task details when the attention list is unchanged", async () => {
    render(<GlobalAttentionProvider />);

    // First poll resolves the fresh attention item (auto-open retry armed).
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    // Focus-out retries auto-open → modal opens → details fetched once.
    await act(async () => {
      window.dispatchEvent(new Event("focusout"));
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
});

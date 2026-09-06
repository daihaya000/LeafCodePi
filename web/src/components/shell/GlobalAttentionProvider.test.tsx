// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
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

import type { AttentionItemDto } from "@/lib/types";
import {
  ATTENTION_BELL_BOTTOM_HOME,
  ATTENTION_BELL_BOTTOM_TASK,
  GlobalAttentionProvider,
  attentionItemStillOpen,
  takeFreshAttentionItems,
} from "./GlobalAttentionProvider";

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

  it("does not start a second poll while the first is still in flight", async () => {
    let attentionCalls = 0;
    let releaseFirst: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        attentionCalls += 1;
        if (attentionCalls === 1) await firstGate;
        return { attention: [{ taskId: "task-a", title: "タスクA", kinds: ["permission"] }] };
      }
      if (path === "/api/tasks/task-a") {
        return { task: taskDetail("task-a") };
      }
      throw new Error(`unexpected: ${path}`);
    });

    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(attentionCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(attentionCalls).toBe(1);

    await act(async () => {
      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.playAttentionRequiredSound).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(attentionCalls).toBe(2);
    expect(mocks.playAttentionRequiredSound).toHaveBeenCalledTimes(1);
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

  it("alerts once the user leaves the task that owned the fresh question", async () => {
    window.history.pushState({}, "", "/task/task-a");
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return { attention: [{ taskId: "task-a", title: "タスクA", kinds: ["question"] }] };
      }
      if (path === "/api/tasks/task-a") {
        return { task: taskDetail("task-a") };
      }
      throw new Error(`unexpected: ${path}`);
    });
    render(<GlobalAttentionProvider />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    // アクティブタスク自身の質問なのでインライン UI 任せ、音は鳴らない。
    expect(mocks.playAttentionRequiredSound).not.toHaveBeenCalled();

    window.history.pushState({}, "", "/task/task-b");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
    });

    // タスクBへ移動した後は「他タスクの注意」になるはずなので鳴るべき。
    expect(mocks.playAttentionRequiredSound).toHaveBeenCalledTimes(1);
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

  it("alerts again after the previous request on the same task is gone", async () => {
    let attention: { taskId: string; title: string; kinds: string[] }[] = [
      { taskId: "task-a", title: "タスクA", kinds: ["permission"] },
    ];
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") return { attention };
      if (path === "/api/tasks/task-a") return { task: taskDetail("task-a") };
      throw new Error(`unexpected: ${path}`);
    });
    render(<GlobalAttentionProvider />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.playAttentionRequiredSound).toHaveBeenCalledTimes(1);

    attention = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
    });

    attention = [{ taskId: "task-a", title: "タスクA", kinds: ["permission"] }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.playAttentionRequiredSound).toHaveBeenCalledTimes(2);
    expect(document.body.textContent ?? "").toMatch(/承認・回答が必要です/);
  });

  it("lets the user reopen dismissed attention for another task", async () => {
    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").toMatch(/承認・回答が必要です/);

    await act(async () => {
      screen.getByRole("button", { name: "後で" }).click();
    });
    expect(document.body.textContent ?? "").not.toMatch(/承認・回答が必要です/);
    const reopen = screen.getByRole("button", { name: "承認・回答が必要なタスク 1 件" });
    expect(reopen.className).toContain(ATTENTION_BELL_BOTTOM_HOME);
    expect(reopen.className).not.toContain(ATTENTION_BELL_BOTTOM_TASK);
    await act(async () => {
      reopen.click();
    });
    expect(document.body.textContent ?? "").toMatch(/承認・回答が必要です/);
  });

  it("lifts the reopen bell above the task composer send button", async () => {
    window.history.pushState({}, "", "/task/task-b");
    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      screen.getByRole("button", { name: "後で" }).click();
    });
    const reopen = screen.getByRole("button", { name: "承認・回答が必要なタスク 1 件" });
    expect(reopen.className).toContain(ATTENTION_BELL_BOTTOM_TASK);
    expect(reopen.className).not.toContain(ATTENTION_BELL_BOTTOM_HOME);
  });

  it("does not show a reopen control when only the active task needs attention", async () => {
    window.history.pushState({}, "", "/task/task-a");
    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("button", { name: /承認・回答が必要なタスク/ })).toBeNull();
  });

  it("keeps mixed attention until both responses resolve", async () => {
    const permissionRequest = {
      id: "req-mixed",
      sessionId: "sess-mixed",
      message: "許可が必要です",
      command: "echo mixed",
      labels: [],
    };
    const questionRequest = {
      id: "question-mixed",
      sessionId: "sess-mixed",
      questions: [{
        header: "確認",
        question: "続けますか？",
        options: [{ label: "はい" }],
        custom: false,
      }],
    };
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return { attention: [{ taskId: "task-a", title: "タスクA", kinds: ["permission", "question"] }] };
      }
      if (path === "/api/tasks/task-a") {
        return { task: { ...taskDetail("task-a"), title: "タスクA", permissionRequest, questionRequest } };
      }
      throw new Error(`unexpected: ${path}`);
    });
    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").toContain("続けますか？");
    expect(document.body.textContent ?? "").toContain("許可が必要です");

    await act(async () => {
      screen.getByRole("button", { name: "許可" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").toContain("続けますか？");
    expect(document.body.textContent ?? "").not.toContain("許可が必要です");

    await act(async () => {
      screen.getByRole("radio", { name: "はい" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").not.toMatch(/承認・回答が必要です/);
  });

  it("keeps another attention kind after one response fails", async () => {
    const permissionRequest = {
      id: "req-failed",
      sessionId: "sess-failed",
      message: "許可に失敗しても質問を残す",
      command: "echo failed",
      labels: [],
    };
    const questionRequest = {
      id: "question-after-failure",
      sessionId: "sess-failed",
      questions: [{
        question: "質問を続けますか？",
        options: [{ label: "はい" }],
        custom: false,
      }],
    };
    let rejectPermission = true;
    mocks.sendJson.mockImplementation(async (path: string) => {
      if (path.endsWith("/permission/advice")) return { advice: "" };
      if (path.endsWith("/permission") && rejectPermission) {
        rejectPermission = false;
        throw new Error("permission failed");
      }
      return {};
    });
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return { attention: [{ taskId: "task-a", title: "タスクA", kinds: ["permission", "question"] }] };
      }
      if (path === "/api/tasks/task-a") {
        return { task: { ...taskDetail("task-a"), title: "タスクA", permissionRequest, questionRequest } };
      }
      throw new Error(`unexpected: ${path}`);
    });
    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      screen.getByRole("button", { name: "許可" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("permission failed")).toBeTruthy();
    expect(document.body.textContent ?? "").toContain("質問を続けますか？");

    await act(async () => {
      screen.getByRole("radio", { name: "はい" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").not.toContain("質問を続けますか？");
    expect(document.body.textContent ?? "").toContain("許可に失敗しても質問を残す");
  });

  it("hides the modal as soon as the user answers a permission", async () => {
    const permissionRequest = {
      id: "req-a",
      sessionId: "sess-a",
      message: "Aを許可しますか",
      command: "echo a",
      labels: [],
    };
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/tasks") {
        return { attention: [{ taskId: "task-a", title: "タスクA", kinds: ["permission"] }] };
      }
      if (path === "/api/tasks/task-a") {
        return { task: { ...taskDetail("task-a"), title: "タスクA", permissionRequest } };
      }
      throw new Error(`unexpected: ${path}`);
    });
    render(<GlobalAttentionProvider />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent ?? "").toMatch(/Aを許可しますか/);

    await act(async () => {
      screen.getByRole("button", { name: "許可" }).click();
    });
    expect(document.body.textContent ?? "").not.toMatch(/承認・回答が必要です/);
    expect(screen.queryByRole("button", { name: /承認・回答が必要なタスク/ })).toBeNull();
  });
});

describe("takeFreshAttentionItems", () => {
  it("forgets resolved keys so the same task can alert again", () => {
    const seen = new Set<string>();
    const item: AttentionItemDto = { taskId: "task-a", title: "A", kinds: ["permission"] };
    expect(takeFreshAttentionItems(seen, [item])).toEqual([item]);
    expect(takeFreshAttentionItems(seen, [item])).toEqual([]);
    expect(takeFreshAttentionItems(seen, [])).toEqual([]);
    expect(takeFreshAttentionItems(seen, [item])).toEqual([item]);
  });
});

describe("attentionItemStillOpen", () => {
  const item: AttentionItemDto = { taskId: "task-a", title: "A", kinds: ["permission"] };

  it("keeps items whose details are not loaded yet", () => {
    expect(attentionItemStillOpen(item, undefined)).toBe(true);
  });

  it("keeps items when GET omitted the request field", () => {
    expect(attentionItemStillOpen(item, { permissionRequest: undefined, questionRequest: undefined })).toBe(
      true,
    );
  });

  it("hides items after the matching request is explicitly cleared", () => {
    expect(attentionItemStillOpen(item, { permissionRequest: null, questionRequest: undefined })).toBe(false);
  });

  it("keeps a combined item until every kind is cleared", () => {
    const both: AttentionItemDto = {
      taskId: "task-a",
      title: "A",
      kinds: ["permission", "question"],
    };
    expect(
      attentionItemStillOpen(both, {
        permissionRequest: null,
        questionRequest: { id: "q1", sessionId: "s", questions: [] },
      }),
    ).toBe(true);
    expect(attentionItemStillOpen(both, { permissionRequest: null, questionRequest: null })).toBe(false);
  });
});

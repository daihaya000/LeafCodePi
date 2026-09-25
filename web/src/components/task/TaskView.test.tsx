// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { ModelOption, TaskSummary, UiMessage } from "@/lib/types";
import { COMPACTION_ACTION_SETTING_KEY } from "@/lib/compaction-settings";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), apiUrl: (path: string) => path, partView: vi.fn(), toolCard: vi.fn(), messageMetaHeader: vi.fn(), markRead: vi.fn(), botFor: vi.fn(), iconFor: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/lib/bot-unread", () => ({ markRead: mocks.markRead }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({ PartView: mocks.partView, ToolCard: mocks.toolCard, MessageMetaHeader: mocks.messageMetaHeader, WorkingRow: () => null }));
vi.mock("@/components/task/ProjectExplorerButton", () => ({ ProjectExplorerButton: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useBotFor: () => mocks.botFor, useIconFor: () => mocks.iconFor }));

import { TaskView } from "./TaskView";
import { clearCachedModels, writeCachedModels } from "@/lib/models-cache";
import { writeTaskTtsEnabled } from "@/lib/tts-playback";

const task: TaskSummary = {
  id: "draft-task", projectId: null, projectName: "test", title: "draft test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => {
  localStorage.clear();
  clearCachedModels();
  vi.clearAllMocks();
  mocks.partView.mockReturnValue(null);
  mocks.toolCard.mockReturnValue(null);
  mocks.messageMetaHeader.mockReturnValue(null);
  mocks.botFor.mockReset();
  mocks.iconFor.mockReset().mockReturnValue(null);
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
  mocks.getJson.mockImplementation((path: string) =>
    path === `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`
      ? Promise.resolve({ value: "suggest" })
      : path === "/api/settings/tts"
        ? Promise.resolve({ enabled: true })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
  );
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  clearCachedModels();
});

it("keeps a document-hidden active task unread until the document is visible", async () => {
  const updatedAt = "2026-01-01T00:00:00.000Z";
  saveTaskSessionCache({ task: { ...task, updatedAt }, messages: [], isStreaming: false, isCompacting: false });
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  try {
    render(<TaskView taskId={task.id} mdUp />);
    await screen.findByRole("heading", { name: task.title });
    expect(mocks.markRead).not.toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.markRead).toHaveBeenCalledWith("task", task.id, Date.parse(updatedAt));
  } finally {
    Reflect.deleteProperty(document, "hidden");
  }
});

it("displays the project icon to the left of the task title", async () => {
  const projectTask = { ...task, projectId: "project-1" };
  const icon = <span data-testid="project-icon" />;
  mocks.iconFor.mockReturnValue(icon);
  saveTaskSessionCache({ task: projectTask, messages: [], isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  const projectIcon = await screen.findByTestId("project-icon");
  const title = screen.getByRole("heading", { name: projectTask.title });
  expect(projectIcon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mocks.iconFor).toHaveBeenCalledWith(task.id, 24, expect.objectContaining({ projectId: "project-1" }));
});

it.each([undefined, "bot-1"])("passes Bot identity only to Bot-sent prompts (botId: %s)", async (botId) => {
  const bot = { id: "bot-1", name: "Code Bot" };
  mocks.botFor.mockImplementation((id) => id === bot.id ? bot : undefined);
  const messages: UiMessage[] = [
    { id: "prompt", role: "user", fromBot: true, createdAt: 1, parts: [{ id: "prompt-text", type: "text", text: "指示" }] },
    { id: "reply", role: "assistant", createdAt: 2, parts: [{ id: "reply-text", type: "text", text: "応答" }] },
    { id: "follow-up", role: "user", createdAt: 3, parts: [{ id: "follow-up-text", type: "text", text: "Code画面からの追加指示" }] },
    { id: "loop-goal", role: "user", goalLoopTurn: { goalId: "goal-1", turn: 1, kind: "goal" }, createdAt: 4, parts: [{ id: "loop-goal-text", type: "text", text: "ループ目標" }] },
  ];
  saveTaskSessionCache({ task: { ...task, botId }, messages, isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  await waitFor(() => expect(mocks.partView).toHaveBeenCalled());
  const props = mocks.partView.mock.calls.map(([value]) => ({ id: value.message.id, role: value.message.role, bot: value.bot }));
  expect(props).toEqual(expect.arrayContaining([
    { id: "prompt", role: "user", bot: botId ? bot : undefined },
    { id: "follow-up", role: "user", bot: undefined },
    // Bot開始セッションのGoal Loop目標は、ユーザー入力欄からの送信ではないのでBotのまま。
    { id: "loop-goal", role: "user", bot: botId ? bot : undefined },
    { id: "reply", role: "assistant", bot: undefined },
  ]));
  expect(props.filter((value) => value.role === "assistant").every((value) => value.bot === undefined)).toBe(true);
});

it("shows the supervising Bot as the sender of the prompts it relays into a user Code task", async () => {
  const bot = { id: "bot-1", name: "監督Bot" };
  mocks.botFor.mockImplementation((id) => id === bot.id ? bot : undefined);
  const messages: UiMessage[] = [
    { id: "bot-prompt", role: "user", fromBot: true, createdAt: 1, parts: [{ id: "bot-prompt-text", type: "text", text: "Botが中継した指示" }] },
    { id: "user-prompt", role: "user", createdAt: 2, parts: [{ id: "user-prompt-text", type: "text", text: "Code画面からの指示" }] },
  ];
  saveTaskSessionCache({ task: { ...task, supervisorBotId: bot.id }, messages, isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  await waitFor(() => expect(mocks.partView).toHaveBeenCalled());
  const props = mocks.partView.mock.calls.map(([value]) => ({ id: value.message.id, bot: value.bot }));
  expect(props).toEqual(expect.arrayContaining([
    { id: "bot-prompt", bot },
    { id: "user-prompt", bot: undefined },
  ]));
  expect(screen.getByRole("img", { name: "監督Botのアバター" })).toBeTruthy();
  expect(screen.queryByText("監督: 監督Bot")).toBeNull();
});

it("keeps the Bot control visible but disabled until an unassigned Code task starts", async () => {
  render(<TaskView taskId={task.id} mdUp />);

  const selector = await screen.findByRole("combobox", { name: "Codeタスクを監督するBot" });
  expect((selector as HTMLSelectElement).disabled).toBe(true);
  expect(selector.closest("label")?.querySelector('[aria-label="ボットアバター"]')).not.toBeNull();
  expect(selector.closest('[aria-label="タスクの状態"]')).toBeNull();
  expect(selector.closest('[aria-label="タスク操作"]')).not.toBeNull();
});

it("lets the user release a delegated Code task before its Bot details load", async () => {
  const delegatedTask = { ...task, kind: "code" as const, supervisorBotId: "bot-1" };
  saveTaskSessionCache({ task: delegatedTask, messages: [], isStreaming: false, isCompacting: false });
  mocks.sendJson.mockResolvedValue({ task: { ...delegatedTask, supervisorBotId: null } });
  render(<TaskView taskId={task.id} mdUp />);

  const selector = await screen.findByRole("combobox", { name: "Codeタスクを監督するBot" });
  expect((selector as HTMLSelectElement).disabled).toBe(false);
  expect(screen.getByRole("option", { name: "委任を解除（ユーザー所有）" })).toBeTruthy();
  fireEvent.change(selector, { target: { value: "__user_ownership__" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/supervisor`,
    { botId: null },
    "POST",
  ));
});

it("lets the user release a delegated Code task to user ownership", async () => {
  const activeTask = { ...task, kind: "code" as const, status: "working" as const, supervisorBotId: "bot-1" };
  saveTaskSessionCache({ task: activeTask, messages: [], isStreaming: true, isCompacting: false });
  mocks.botFor.mockImplementation((id) => id === "bot-1" ? { id, name: "監督Bot" } : undefined);
  mocks.sendJson.mockResolvedValue({ task: { ...activeTask, supervisorBotId: null } });
  render(<TaskView taskId={task.id} mdUp />);

  const selector = await screen.findByRole("combobox", { name: "Codeタスクを監督するBot" });
  expect(screen.getByRole("option", { name: "委任を解除（ユーザー所有）" })).toBeTruthy();
  fireEvent.change(selector, { target: { value: "__user_ownership__" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/supervisor`,
    { botId: null },
    "POST",
  ));
});

it("lets the user hand an active Code task to an enabled Bot", async () => {
  const activeTask = { ...task, kind: "code" as const, status: "working" as const };
  saveTaskSessionCache({ task: activeTask, messages: [], isStreaming: true, isCompacting: false });
  mocks.getJson.mockImplementation((path: string) => {
    if (path === "/api/bots") return Promise.resolve({ bots: [{ id: "bot-1", name: "監督Bot", enabled: true }] });
    return Promise.resolve({ models: [], agents: [], skills: [], accounts: [] });
  });
  const resultTask = { ...activeTask, supervisorBotId: "bot-1" };
  mocks.sendJson.mockResolvedValue({ task: resultTask });
  render(<TaskView taskId={task.id} mdUp />);

  const selector = await screen.findByRole("combobox", { name: "Codeタスクを監督するBot" });
  fireEvent.change(selector, { target: { value: "bot-1" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/supervisor`,
    { botId: "bot-1" },
    "POST",
  ));
});

it("does not reconnect SSE when the status callback identity changes", async () => {
  let connections = 0;
  class TestEventSource extends EventTarget {
    constructor() {
      super();
      connections += 1;
    }

    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const view = render(<TaskView taskId={task.id} mdUp onStatus={vi.fn()} />);
  await waitFor(() => expect(connections).toBe(1));
  view.rerender(<TaskView taskId={task.id} mdUp onStatus={vi.fn()} />);
  expect(connections).toBe(1);
});

it("renders a submitted user prompt only after the authoritative SSE message", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource | null = null;
    constructor() {
      super();
      TestEventSource.latest = this;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.sendJson.mockResolvedValue({ task });
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-message={message.id}>{message.parts[0]?.type === "text" ? message.parts[0].text : ""}</div>
  ));
  render(<TaskView taskId={task.id} mdUp />);
  const input = screen.getByRole("textbox", { name: "フォローアップ" });
  fireEvent.change(input, { target: { value: "同じ指示" } });
  fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/prompt`,
    expect.objectContaining({ prompt: "同じ指示" }),
  ));
  expect(document.querySelectorAll("[data-task-message]")).toHaveLength(0);

  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({
        eventType: "message_start",
        task: { ...task, status: "working", isStreaming: true },
        messages: [{
          id: "entry-42",
          role: "user",
          createdAt: 1,
          parts: [{ type: "text", id: "entry-42-text", text: "同じ指示" }],
        }],
        isStreaming: true,
      }),
    }));
    await Promise.resolve();
  });

  await waitFor(() => expect(document.querySelectorAll("[data-task-message]")).toHaveLength(1));
  expect(document.querySelector("[data-task-message]")?.textContent).toBe("同じ指示");
});

it("injects an extra prompt into a live Goal loop instead of refusing it", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource | null = null;
    constructor() {
      super();
      TestEventSource.latest = this;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.sendJson.mockResolvedValue({ task });
  render(<TaskView taskId={task.id} mdUp />);
  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({
        eventType: "message_start",
        task: { ...task, status: "working", isStreaming: true, goalLoop: { id: "loop-1", status: "running", goal: "目標", acceptance: ["ok"], maxTurns: 5, turnCount: 1 } },
        messages: [],
        isStreaming: true,
      }),
    }));
    await Promise.resolve();
  });

  const input = screen.getByRole("textbox", { name: "フォローアップ" });
  fireEvent.change(input, { target: { value: "追加の指示" } });
  // 送信ボタン自体が無効のままだと送れないため、押して送れることも固定する。
  fireEvent.click(screen.getByRole("button", { name: "差し込みを送信" }));

  // ループは止めない: クライアント側キューではなく実行中ターンへの差し込みとして送る。
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/prompt`,
    expect.objectContaining({ prompt: "追加の指示", streamingBehavior: "steer" }),
  ));
  expect(screen.queryByText("Goal loop の実行中は追加の送信はできません")).toBeNull();
});

it("does not render a user message twice when SSE reprojects its ids", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource | null = null;
    constructor() {
      super();
      TestEventSource.latest = this;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-message={message.id}>{message.parts[0]?.type === "text" ? message.parts[0].text : ""}</div>
  ));
  render(<TaskView taskId={task.id} mdUp />);
  await waitFor(() => expect(TestEventSource.latest).toBeTruthy());
  const streamed: UiMessage = {
    id: "msg-3",
    role: "user",
    createdAt: 1,
    parts: [{ type: "text", id: "msg-3-text", text: "同じ指示" }],
  };
  const persisted: UiMessage = {
    id: "entry-42",
    role: "user",
    createdAt: 1,
    parts: [{ type: "text", id: "entry-42-text", text: "同じ指示" }],
  };
  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("delta", {
      data: JSON.stringify({ message: streamed }),
    }));
    await Promise.resolve();
  });
  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({
        eventType: "agent_end",
        task: { ...task, status: "working", isStreaming: true },
        messages: [persisted],
        isStreaming: true,
      }),
    }));
    await Promise.resolve();
  });

  await waitFor(() => expect(document.querySelectorAll("[data-task-message]")).toHaveLength(1));
  expect(document.querySelector("[data-task-message]")?.getAttribute("data-task-message")).toBe("entry-42");
});

it("stops following the bottom after the user scrolls up from a programmatic follow", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource | null = null;
    constructor() {
      super();
      TestEventSource.latest = this;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const messages: UiMessage[] = Array.from({ length: 51 }, (_, index) => ({
    id: `history-${index}`,
    role: "user" as const,
    createdAt: index,
    parts: [{ id: `history-${index}-text`, type: "text" as const, text: `message-${index}` }],
  }));
  render(<TaskView taskId={task.id} mdUp />);
  const viewport = document.querySelector<HTMLElement>(".overflow-y-auto");
  if (!viewport || !TestEventSource.latest) throw new Error("Task timeline was not rendered");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  Object.defineProperty(viewport, "scrollTo", {
    configurable: true,
    value: ({ top }: { top: number }) => { viewport.scrollTop = top; },
  });

  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({
        eventType: "ready",
        task,
        messages,
        messageHistory: { hasMore: true, nextCursor: "history-0" },
        isStreaming: false,
      }),
    }));
    await Promise.resolve();
  });
  expect(viewport.scrollTop).toBe(800);

  viewport.scrollTop = 400;
  fireEvent.scroll(viewport);
  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("delta", {
      data: JSON.stringify({
        message: {
          id: "new-message",
          role: "user",
          createdAt: 52,
          parts: [{ id: "new-message-text", type: "text", text: "new" }],
        },
      }),
    }));
    await Promise.resolve();
  });
  expect(viewport.scrollTop).toBe(400);
});

it("loads older history only when selected, not while scrolling", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource | null = null;
    constructor() {
      super();
      TestEventSource.latest = this;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const messagePath = `/api/tasks/${encodeURIComponent(task.id)}/messages`;
  render(<TaskView taskId={task.id} mdUp />);
  const viewport = document.querySelector<HTMLElement>(".overflow-y-auto");
  if (!viewport || !TestEventSource.latest) throw new Error("Task timeline was not rendered");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  Object.defineProperty(viewport, "scrollTo", {
    configurable: true,
    value: ({ top }: { top: number }) => { viewport.scrollTop = top; },
  });
  await act(async () => {
    TestEventSource.latest!.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({
        eventType: "ready",
        task,
        messages: [{ id: "latest", role: "user", createdAt: 1, parts: [{ id: "latest-text", type: "text", text: "latest" }] }],
        messageHistory: { hasMore: true, nextCursor: "oldest" },
        isStreaming: false,
      }),
    }));
    await Promise.resolve();
  });

  fireEvent.scroll(viewport);
  expect(mocks.getJson.mock.calls.some(([path]) => path === messagePath)).toBe(false);

  mocks.getJson.mockImplementation((path: string) =>
    path === messagePath
      ? Promise.resolve({ messages: [], messageHistory: { hasMore: false, nextCursor: null } })
      : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
  );
  fireEvent.click(screen.getByRole("button", { name: "過去の履歴を読み込む" }));
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith(messagePath, { before: "oldest" }));
});

it("refreshes the newest page when an older-history cursor is stale", async () => {
  const latest: UiMessage = {
    id: "fresh-message",
    role: "user",
    createdAt: 2,
    parts: [{ id: "fresh-message-text", type: "text", text: "fresh" }],
  };
  const messagePath = `/api/tasks/${encodeURIComponent(task.id)}/messages`;
  mocks.getJson.mockImplementation((path: string, params?: { before?: string }) => {
    if (path === messagePath && params?.before) {
      return Promise.reject(Object.assign(new Error("履歴カーソルが無効です"), { status: 409 }));
    }
    if (path === messagePath) {
      return Promise.resolve({
        messages: [latest],
        messageHistory: { hasMore: true, nextCursor: "fresh-cursor" },
      });
    }
    return Promise.resolve({ models: [], agents: [], skills: [], accounts: [] });
  });
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
  const messages: UiMessage[] = [
    { id: "stale-message", role: "user", createdAt: 1, parts: [{ id: "stale-text", type: "text", text: "stale" }] },
  ];
  await waitFor(() => expect(TestEventSource.latest).toBeTruthy());
  TestEventSource.latest!.dispatchEvent(new MessageEvent("snapshot", {
    data: JSON.stringify({
      eventType: "ready",
      task,
      messages,
      messageHistory: { hasMore: true, nextCursor: "stale-cursor" },
      isStreaming: false,
    }),
  }));
  await waitFor(() => expect(screen.getByRole("button", { name: "過去の履歴を読み込む" })).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "過去の履歴を読み込む" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith(messagePath));
  expect(mocks.getJson.mock.calls.filter(([path]) => path === messagePath)).toEqual(
    expect.arrayContaining([[messagePath, { before: "stale-cursor" }], [messagePath]]),
  );
  expect(screen.queryByText("履歴カーソルが無効です")).toBeNull();
});

it("ignores callbacks from an SSE source replaced after a transport error", async () => {
  vi.useFakeTimers();
  try {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      closed = false;
      constructor() {
        super();
        TestEventSource.instances.push(this);
      }
      close() { this.closed = true; }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    render(<TaskView taskId={task.id} mdUp />);

    const first = TestEventSource.instances[0];
    if (!first) throw new Error("Initial EventSource was not created");
    act(() => first.dispatchEvent(new Event("error")));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(1_000); });

    const second = TestEventSource.instances[1];
    if (!second) throw new Error("Reconnect EventSource was not created");
    expect(second.closed).toBe(false);
    act(() => first.dispatchEvent(new Event("error")));
    expect(second.closed).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("shows one Goal Loop turn divider per turn boundary", () => {
  const turnMessage = (id: string, turn: number, kind: "goal" | "verification"): UiMessage => ({
    id,
    role: "assistant",
    createdAt: turn,
    goalLoopTurn: { goalId: "loop-1", turn, kind },
    parts: [{
      id: `${id}-part`,
      type: "tool",
      tool: "read",
      callID: `${id}-call`,
      state: { status: "completed", input: { path: "README.md" } },
    }],
  });
  saveTaskSessionCache({
    task,
    messages: [
      { ...turnMessage("a1", 1, "goal") },
      { ...turnMessage("a1-follow-up", 1, "goal") },
      { ...turnMessage("a1-verify", 1, "verification") },
      { ...turnMessage("a2", 2, "goal") },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);

  expect(screen.getByRole("separator", { name: "ループ 1" })).toBeTruthy();
  expect(screen.getByRole("separator", { name: "ループ 1（完了検証）" })).toBeTruthy();
  expect(screen.getByRole("separator", { name: "ループ 2" })).toBeTruthy();
  expect(screen.getByText("検証")).toBeTruthy();
});

it("groups consecutive tool-only messages between agent responses", () => {
  // tool-1 は 2.0s〜3.0s、tool-2 は 4.0s〜5.0s に実行される想定。
  const toolMessage = (id: string): UiMessage => {
    const startedAtMs = Number(id.slice(-1)) * 2_000;
    return {
      id,
      role: "assistant",
      createdAt: Number(id.slice(-1)),
      parts: [{
        id: `${id}-part`,
        type: "tool",
        tool: "read",
        callID: `${id}-call`,
        state: {
          status: "completed",
          input: { path: "README.md" },
          startedAtMs,
          endedAtMs: startedAtMs + 1_000,
        },
      }],
    };
  };
  saveTaskSessionCache({
    task,
    messages: [
      { id: "user-1", role: "user", createdAt: 1, parts: [{ id: "user-1-part", type: "text", text: "確認して" }] },
      toolMessage("tool-1"),
      toolMessage("tool-2"),
      { id: "reply-1", role: "assistant", createdAt: 4, parts: [{ id: "reply-1-part", type: "text", text: "確認しました" }] },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.toolCard.mockImplementation(({ part }: { part: { id: string } }) => (
    <div data-task-tool-card={part.id} />
  ));
  mocks.messageMetaHeader.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-meta={message.id} />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const group = document.querySelector<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(group).not.toBeNull();
  expect(group!.className).toContain("max-w-bubble");
  expect(group!.open).toBe(false);
  expect(group!.getAttribute("aria-label")).toBe("作業ログ");
  expect(group!.querySelector("summary")?.textContent).toContain("作業ログ");
  expect(group!.querySelector("summary .lucide-scroll-text")?.getAttribute("aria-hidden")).toBe("true");
  expect(group!.querySelector("summary")?.textContent).toContain("2件");
  // 最初の開始(2.0s)から最後の終了(5.0s)までの経過時間。所要時間の合計(2s)ではない。
  expect(group!.querySelector("summary")?.textContent).toContain("3s");
  expect(group!.querySelectorAll("[data-task-tool-card]")).toHaveLength(2);
  // 先頭のメタ行は閉じた状態でも見せ、展開内容にも各メッセージのメタ行を残す。
  expect(group!.previousElementSibling?.querySelector("[data-task-meta]")?.getAttribute("data-task-meta")).toBe("tool-1");
  expect([...group!.querySelectorAll("[data-task-meta]")].map((node) => node.getAttribute("data-task-meta"))).toEqual([
    "tool-1",
    "tool-2",
  ]);
  expect(document.querySelectorAll("[data-task-meta]")).toHaveLength(3);
  fireEvent.click(group!.querySelector("summary")!);
  expect(group!.open).toBe(true);
});

it("groups every non-message part while keeping each message header", () => {
  const mixedMessage: UiMessage = {
    id: "assistant-mixed",
    role: "assistant",
    createdAt: 1,
    model: "model-a",
    outputTokens: 42,
    error: "応答エラー",
    diagnostics: [{ type: "transport", error: { message: "再接続" } }],
    parts: [
      { id: "mixed-text", type: "text", text: "確認します" },
      { id: "mixed-thinking", type: "thinking", text: "考えています" },
      { id: "mixed-image", type: "image", url: "data:image/png;base64,AA==", mime: "image/png" },
    ],
  };
  const activityMessage: UiMessage = {
    id: "activity-only",
    role: "assistant",
    createdAt: 2,
    parts: [{ id: "activity-thinking", type: "thinking", text: "続けます" }],
  };
  saveTaskSessionCache({
    task,
    messages: [mixedMessage, activityMessage, { id: "reply", role: "assistant", createdAt: 3, parts: [{ id: "reply-text", type: "text", text: "完了" }] }],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message, hideMeta }: { message: UiMessage; hideMeta?: boolean }) => (
    <div
      data-task-part-view={hideMeta ? "activity" : "message"}
      data-message-id={message.id}
      data-part-types={message.parts.map((part) => part.type).join(",")}
    />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(2);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("4件");
  expect(groups[1]!.querySelector("summary")?.textContent).toContain("1件");
  // thinking や画像は本文より前に起きているので、本文より上へ出す。
  expect(
    [...document.querySelectorAll("[data-task-part-view]")].map(
      (node) => `${node.getAttribute("data-task-part-view")}:${node.getAttribute("data-message-id")}`,
    ),
  ).toEqual([
    "activity:assistant-mixed",
    "message:assistant-mixed",
    "activity:activity-only",
    "message:reply",
  ]);
  expect(document.querySelector('[data-task-part-view="message"][data-message-id="assistant-mixed"]')?.getAttribute("data-part-types")).toBe("text");
  expect(mocks.messageMetaHeader.mock.calls.some(([props]) => props.message.id === "activity-only")).toBe(true);
});

it("does not split the activity log on assistant text that precedes a tool call", () => {
  const preamble = (id: string, createdAt: number): UiMessage => ({
    id,
    role: "assistant",
    createdAt,
    parts: [
      { id: `${id}-text`, type: "text", text: "次に確認します" },
      {
        id: `${id}-tool`,
        type: "tool",
        tool: "read",
        callID: `${id}-call`,
        state: { status: "completed", input: { path: "README.md" } },
      },
    ],
  });
  saveTaskSessionCache({
    task,
    messages: [
      preamble("step-1", 1),
      preamble("step-2", 2),
      { id: "reply", role: "assistant", createdAt: 3, parts: [{ id: "reply-text", type: "text", text: "完了しました" }] },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message, hideMeta }: { message: UiMessage; hideMeta?: boolean }) => (
    <div data-task-part-view={hideMeta ? "activity" : "message"} data-message-id={message.id} />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(1);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("4件");
  expect(groups[0]!.querySelectorAll("[data-task-part-view]")).toHaveLength(2);
  expect(document.querySelector('[data-task-part-view="message"][data-message-id="reply"]')).not.toBeNull();
});

it("keeps a long reply outside the activity log even when a tool follows it", () => {
  // 前置きと見なせない長い本文は、ツールと同じメッセージでも折りたたみへ隐さない。
  saveTaskSessionCache({
    task,
    messages: [
      {
        id: "long-reply",
        role: "assistant",
        createdAt: 1,
        parts: [
          { id: "long-text", type: "text", text: "結果を報告します。".repeat(40) },
          {
            id: "long-tool",
            type: "tool",
            tool: "read",
            callID: "long-call",
            state: { status: "completed", input: { path: "README.md" } },
          },
        ],
      },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message, hideMeta }: { message: UiMessage; hideMeta?: boolean }) => (
    <div
      data-task-part-view={hideMeta ? "activity" : "message"}
      data-message-id={message.id}
      data-part-types={message.parts.map((part) => part.type).join(",")}
    />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const reply = document.querySelector('[data-task-part-view="message"][data-message-id="long-reply"]');
  expect(reply?.getAttribute("data-part-types")).toBe("text");
  expect(document.querySelector("details[data-task-tool-group]")?.contains(reply!)).toBe(false);
});

it("keeps a thinking-only reply visible outside the activity log", () => {
  // 回帰: ツールを伴わない thinking+本文はそのターンの回答なので、折りたたみに隐さない。
  saveTaskSessionCache({
    task,
    messages: [
      {
        id: "tool-step",
        role: "assistant",
        createdAt: 1,
        parts: [{
          id: "tool-step-part",
          type: "tool",
          tool: "read",
          callID: "tool-step-call",
          state: { status: "completed", input: { path: "README.md" } },
        }],
      },
      {
        id: "final-reply",
        role: "assistant",
        createdAt: 2,
        parts: [
          { id: "final-thinking", type: "thinking", text: "まとめる" },
          { id: "final-text", type: "text", text: "完了しました" },
        ],
      },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message, hideMeta }: { message: UiMessage; hideMeta?: boolean }) => (
    <div
      data-task-part-view={hideMeta ? "activity" : "message"}
      data-message-id={message.id}
      data-part-types={message.parts.map((part) => part.type).join(",")}
    />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const reply = document.querySelector('[data-task-part-view="message"][data-message-id="final-reply"]');
  expect(reply?.getAttribute("data-part-types")).toBe("text");
  expect(document.querySelector("details[data-task-tool-group]")?.contains(reply!)).toBe(false);
});

it("keeps the streaming placeholder header out of the timeline until its content lands", () => {
  // 回帰: 空の生成中メッセージを単独行として出すと、ヘッダーが作業ログの
  // 枠外へ一瞬逃げ、開いていたグループも分断された。
  const messages: UiMessage[] = [
    {
      id: "tool-1",
      role: "assistant",
      createdAt: 1,
      parts: [{
        id: "tool-1-part",
        type: "tool",
        tool: "read",
        callID: "tool-1-call",
        state: { status: "completed", input: { path: "README.md" } },
      }],
    },
    { id: "streaming", role: "assistant", createdAt: 2, model: "model-a", parts: [] },
  ];
  saveTaskSessionCache({
    task: { ...task, status: "working" },
    messages,
    isStreaming: true,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-part-view={message.id} />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(1);
  expect(document.querySelector('[data-task-part-view="streaming"]')).toBeNull();
});

it("does not split activity logs on completed empty assistant messages", () => {
  const toolMessage = (id: string): UiMessage => ({
    id,
    role: "assistant",
    createdAt: 1,
    parts: [{
      id: `${id}-part`,
      type: "tool",
      tool: "read",
      callID: `${id}-call`,
      state: { status: "completed", input: { path: "README.md" } },
    }],
  });
  saveTaskSessionCache({
    task,
    messages: [
      toolMessage("tool-1"),
      { id: "silent-reply", role: "assistant", createdAt: 2, model: "model-a", parts: [] },
      { id: "whitespace-reply", role: "assistant", createdAt: 3, parts: [{ id: "whitespace-text", type: "text", text: " " }] },
      toolMessage("tool-2"),
    ],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-part-view={message.id} />
  ));
  mocks.toolCard.mockImplementation(({ part }: { part: { id: string } }) => (
    <div data-task-tool-card={part.id} />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(1);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("2件");
  expect(groups[0]!.querySelectorAll("[data-task-tool-card]")).toHaveLength(2);
  expect(document.querySelector('[data-task-part-view="silent-reply"]')).toBeNull();
  expect(document.querySelector('[data-task-part-view="whitespace-reply"]')).toBeNull();
});

it("keeps whitespace-only assistant text inside the activity log", () => {
  const toolMessage = (id: string): UiMessage => ({
    id,
    role: "assistant",
    createdAt: 1,
    parts: [{
      id: `${id}-part`,
      type: "tool",
      tool: "read",
      callID: `${id}-call`,
      state: { status: "completed", input: { path: "README.md" } },
    }],
  });
  const whitespaceMessage: UiMessage = {
    id: "whitespace-reply",
    role: "assistant",
    createdAt: 2,
    model: "model-a",
    parts: [
      { id: "whitespace-text", type: "text", text: " " },
      {
        id: "whitespace-tool",
        type: "tool",
        tool: "read",
        callID: "whitespace-call",
        state: { status: "completed", input: { path: "README.md" } },
      },
    ],
  };
  saveTaskSessionCache({
    task,
    messages: [toolMessage("tool-1"), whitespaceMessage, toolMessage("tool-2")],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-part-view={message.id} />
  ));
  mocks.toolCard.mockImplementation(({ part }: { part: { id: string } }) => (
    <div data-task-tool-card={part.id} />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(1);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("3件");
  expect(groups[0]!.querySelectorAll("[data-task-tool-card]")).toHaveLength(3);
  expect(document.querySelector('[data-task-part-view="whitespace-reply"]')).toBeNull();
  expect(mocks.messageMetaHeader.mock.calls.some(([props]) => props.message.id === "whitespace-reply")).toBe(true);
});

it("hides empty Goal Loop assistants and keeps their turn divider on the next block", () => {
  // 回帰: Goal Loop 中の空 assistant がヘッダーだけの行として残り、作業ログを分断していた。
  const toolMessage = (id: string, turn: number): UiMessage => ({
    id,
    role: "assistant",
    createdAt: turn,
    goalLoopTurn: { goalId: "loop-1", turn, kind: "goal" },
    parts: [{
      id: `${id}-part`,
      type: "tool",
      tool: "read",
      callID: `${id}-call`,
      state: { status: "completed", input: { path: "README.md" } },
    }],
  });
  saveTaskSessionCache({
    task,
    messages: [
      toolMessage("tool-1", 1),
      { id: "empty-1", role: "assistant", createdAt: 1, model: "model-a", goalLoopTurn: { goalId: "loop-1", turn: 1, kind: "goal" }, parts: [] },
      toolMessage("tool-2", 1),
      { id: "empty-2", role: "assistant", createdAt: 2, model: "model-a", goalLoopTurn: { goalId: "loop-1", turn: 2, kind: "goal" }, parts: [{ id: "empty-2-text", type: "text", text: "\n" }] },
      toolMessage("tool-3", 2),
    ],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
    <div data-task-part-view={message.id} />
  ));
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(2);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("2件");
  expect(groups[1]!.querySelector("summary")?.textContent).toContain("1件");
  expect(document.querySelector('[data-task-part-view="empty-1"]')).toBeNull();
  expect(document.querySelector('[data-task-part-view="empty-2"]')).toBeNull();
  // 空メッセージで始まるターンでも区切りは残す。
  expect(screen.getByRole("separator", { name: "ループ 2" })).toBeTruthy();
});

it("splits tool groups at Goal Loop turn boundaries", () => {
  const toolMessage = (id: string, turn: number): UiMessage => ({
    id,
    role: "assistant",
    createdAt: turn,
    goalLoopTurn: { goalId: "loop-1", turn, kind: "goal" },
    parts: [{
      id: `${id}-part`,
      type: "tool",
      tool: "read",
      callID: `${id}-call`,
      state: { status: "completed", input: { path: "README.md" } },
    }],
  });
  saveTaskSessionCache({
    task,
    messages: [toolMessage("tool-1", 1), toolMessage("tool-2", 1), toolMessage("tool-3", 2)],
    isStreaming: false,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);

  const groups = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(groups).toHaveLength(2);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("2件");
  expect(groups[1]!.querySelector("summary")?.textContent).toContain("1件");
  expect(screen.getByRole("separator", { name: "ループ 1" })).toBeTruthy();
  expect(screen.getByRole("separator", { name: "ループ 2" })).toBeTruthy();
});

describe("TaskView draft submission", () => {
  it("shows the manual context compaction control and sends the compaction request", async () => {
    mocks.sendJson.mockResolvedValue({
      task: { ...task, messages: [], isStreaming: false, isCompacting: false },
    });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(await screen.findByRole("button", { name: "コンテキスト圧縮" }));

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/compact`, {}, "POST", { timeoutMs: 240_000 },
    ));
  });

  it("hides the manual context compaction control for auto-compaction", async () => {
    mocks.getJson.mockImplementation((path: string) =>
      path === `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`
        ? Promise.resolve({ value: "auto" })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
    );
    render(<TaskView taskId={task.id} mdUp />);

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith(
      `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`,
    ));
    expect(screen.queryByRole("button", { name: "コンテキスト圧縮" })).toBeNull();
  });

  it("hides the read-aloud toggle when global TTS is disabled", async () => {
    mocks.getJson.mockImplementation((path: string) =>
      path === "/api/settings/tts"
        ? Promise.resolve({ enabled: false })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
    );
    render(<TaskView taskId={task.id} mdUp />);

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/settings/tts"));
    expect(screen.queryByRole("switch", { name: "読み上げ" })).toBeNull();
  });

  it("clears isCompacting when the compaction request fails", async () => {
    mocks.sendJson.mockReset();
    mocks.sendJson.mockRejectedValue(new Error("compact failed"));
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(await screen.findByRole("button", { name: "コンテキスト圧縮" }));

    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        `/api/tasks/${task.id}/compact`,
        {},
        "POST",
        { timeoutMs: 240_000 },
      );
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "コンテキスト圧縮" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(screen.queryByText(/圧縮中/)).toBeNull();
  });

  it("clears compactingLocal when compaction is aborted mid-flight", async () => {
    let releaseCompact!: () => void;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    mocks.sendJson.mockImplementation(async (url: string) => {
      if (String(url).includes("/compact/abort")) {
        return { task: { ...task, messages: [], isStreaming: false, isCompacting: false } };
      }
      if (String(url).includes("/compact")) {
        await compactGate;
        throw new Error("compact aborted");
      }
      return { task: { ...task, messages: [], isStreaming: false, isCompacting: false } };
    });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(await screen.findByRole("button", { name: "コンテキスト圧縮" }));
    await waitFor(() => {
      expect(screen.getByText(/コンテキストを圧縮しています/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => {
      expect(screen.queryByText(/コンテキストを圧縮しています/)).toBeNull();
    });
    expect(
      (screen.getByRole("button", { name: "コンテキスト圧縮" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    releaseCompact();
  });

  it("clears compacting flags when abort compact API fails", async () => {
    let releaseCompact!: () => void;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    mocks.sendJson.mockImplementation(async (url: string) => {
      if (String(url).includes("/compact/abort")) {
        throw new Error("abort failed");
      }
      if (String(url).includes("/compact")) {
        await compactGate;
        throw new Error("compact aborted");
      }
      return { task: { ...task, messages: [], isStreaming: false, isCompacting: false } };
    });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(await screen.findByRole("button", { name: "コンテキスト圧縮" }));
    await waitFor(() => {
      expect(screen.getByText(/コンテキストを圧縮しています/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => {
      expect(screen.getByText(/abort failed/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText(/コンテキストを圧縮しています/)).toBeNull();
    });
    expect(
      (screen.getByRole("button", { name: "コンテキスト圧縮" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    releaseCompact();
  });

  it("clears session hydration after a fatal SSE error event", async () => {
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

    await waitFor(() => {
      expect(screen.getByText(/セッションを準備しています/)).toBeTruthy();
    });

    await act(async () => {
      source.dispatchEvent(
        new MessageEvent("error", {
          data: JSON.stringify({ error: "task gone" }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/task gone/)).toBeTruthy();
    });
    expect(screen.queryByText(/セッションを準備しています/)).toBeNull();
  });

  it("auto-resumes a silent turn only after its agent_settled snapshot", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      static latestUrl = "";
      constructor(url: string) {
        super();
        TestEventSource.latest = this;
        TestEventSource.latestUrl = url;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const cachedTask = {
      ...task,
      sessionId: "session-1",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    saveTaskSessionCache({
      task: cachedTask,
      messages: [
        {
          id: "cached-prompt",
          role: "user",
          createdAt: 1,
          parts: [{ id: "cached-prompt-text", type: "text", text: "元の指示" }],
        },
        { id: "cached-empty-reply", role: "assistant", createdAt: 2, parts: [] },
      ],
      isStreaming: false,
      isCompacting: false,
    });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");
    expect(new URL(TestEventSource.latestUrl, "http://localhost").searchParams.get(
      "cachedSilentResumeCandidate",
    )).toBe("1");

    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "cache_ready",
          task: cachedTask,
          messagesReused: true,
          isStreaming: false,
          isCompacting: false,
        }),
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mocks.sendJson.mock.calls.some(([url]) => url === `/api/tasks/${task.id}/prompt`)).toBe(false);

    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: cachedTask,
          messages: [
            {
              id: "cached-prompt",
              role: "user",
              createdAt: 1,
              parts: [{ id: "cached-prompt-text", type: "text", text: "元の指示" }],
            },
            { id: "authoritative-reply", role: "assistant", createdAt: 2, parts: [] },
          ],
          isStreaming: false,
          isCompacting: false,
        }),
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mocks.sendJson.mock.calls.some(([url]) => url === `/api/tasks/${task.id}/prompt`)).toBe(false);

    mocks.sendJson.mockResolvedValue({ task: cachedTask });
    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "agent_settled",
          task: cachedTask,
          messages: [
            {
              id: "cached-prompt",
              role: "user",
              createdAt: 1,
              parts: [{ id: "cached-prompt-text", type: "text", text: "元の指示" }],
            },
            { id: "authoritative-reply", role: "assistant", createdAt: 2, parts: [] },
          ],
          isStreaming: false,
          isCompacting: false,
        }),
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`,
      expect.objectContaining({ prompt: "続けて", resume: true }),
    );
  });

  it("places the read-aloud toggle immediately to the right of the Bot control", async () => {
    const delegatedTask = { ...task, kind: "code" as const, status: "working" as const, supervisorBotId: "bot-1" };
    saveTaskSessionCache({ task: delegatedTask, messages: [], isStreaming: true, isCompacting: false });
    mocks.botFor.mockImplementation((id) => id === "bot-1" ? { id, name: "監督Bot" } : undefined);
    render(<TaskView taskId={task.id} mdUp />);

    const selector = await screen.findByRole("combobox", { name: "Codeタスクを監督するBot" });
    const botControl = selector.closest("label");
    // The compaction and TTS controls appear only after the settings fetch settles.
    const compact = await screen.findByRole("button", { name: "コンテキスト圧縮" });
    const tts = await screen.findByRole("switch", { name: "読み上げ" });
    expect(botControl?.previousElementSibling).toBe(compact);
    expect(tts.previousElementSibling).toBe(botControl);
  });

  it("shows and applies a context compaction suggestion", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({
      task: { ...task, messages: [], isStreaming: false, isCompacting: false },
    });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, sessionId: "session-1", status: "idle" },
          messages: [],
          isStreaming: false,
          isCompacting: false,
          contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
          compactionSuggested: true,
        }),
      }));
    });

    expect(await screen.findByText("コンテキスト使用率が閾値に達しました。圧縮をおすすめします。"))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "今すぐ圧縮" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/compact`, {}, "POST", { timeoutMs: 240_000 },
    ));
  });

  it("shows context and token statistics beside the session label, not in the status row", () => {
    saveTaskSessionCache({
      task: { ...task, label: "code" },
      messages: [{
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        inputTokens: 3400,
        outputTokens: 1200,
        tokensPerSecond: 20,
        parts: [],
      }],
      isStreaming: false,
      isCompacting: false,
      contextUsage: { tokens: 405_000, contextWindow: 1_000_000, percent: 41 },
    });
    render(<TaskView taskId={task.id} mdUp={false} />);

    const sessionInfo = screen.getByLabelText("セッション情報");
    const status = screen.getByLabelText("タスクの状態");
    expect(sessionInfo.textContent).toContain("コード");
    const meter = screen.getByTitle("コンテキスト使用量: 405k / 1M トークン（41%）");
    const tokens = screen.getByTitle("合計 ↑3.4k ↓1.2k tok");
    const rate = screen.getByTitle("平均 tok/s（応答ごとの tok/s の平均）");
    expect(sessionInfo.contains(meter)).toBe(true);
    expect(sessionInfo.contains(tokens)).toBe(true);
    expect(sessionInfo.contains(rate)).toBe(true);
    expect(sessionInfo.className).toContain("overflow-hidden");
    expect(meter.querySelector(".truncate")).toBeTruthy();
    expect(status.contains(meter)).toBe(false);
    expect(status.contains(tokens)).toBe(false);
    expect(tokens.className).toContain("@min-[48rem]/task:inline");
    expect(rate.className).toContain("@min-[48rem]/task:inline");
    expect(meter.className).toContain("text-[10px]");
  });

  it("edits the full title directly and keeps secondary actions separate", () => {
    const title = "再起動オーバーレイの表示条件とヘッダーレイアウトを改善する";
    saveTaskSessionCache({ task: { ...task, title }, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp={false} />);

    const heading = screen.getByRole("heading", { name: title });
    expect(screen.queryByRole("button", { name: `タイトルを編集: ${title}` })).toBeNull();
    expect(heading.textContent).toBe(title);
    expect(screen.getAllByText("クリーン")).toHaveLength(1);
    const generateTitle = screen.getByRole("button", { name: "タイトルを生成" });
    expect(screen.getByRole("group", { name: "タスク操作" }).contains(generateTitle)).toBe(false);
    expect(heading.compareDocumentPosition(generateTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(heading);
    const input = screen.getByRole("textbox", { name: "セッションタイトル" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("heading", { name: title }), { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "セッションタイトル" })).toBeTruthy();
    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it("edits the title and turns automatic updates off", async () => {
    const updatedTask = { ...task, title: "手動タイトル", titleAutoUpdate: false };
    mocks.sendJson.mockResolvedValue({ task: updatedTask });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(screen.getByRole("heading", { name: task.title }));
    const input = screen.getByRole("textbox", { name: "セッションタイトル" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "手動タイトル" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトルを保存" }));

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/title`, { title: "手動タイトル" }, "PATCH",
    ));
    expect(await screen.findByRole("heading", { name: "手動タイトル" })).toBeTruthy();
  });

  it("generates a title only when the manual button is pressed", async () => {
    const updatedTask = { ...task, title: "生成タイトル" };
    mocks.sendJson.mockResolvedValue({ title: "生成タイトル", task: updatedTask });
    render(<TaskView taskId={task.id} mdUp />);

    expect(mocks.sendJson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "タイトルを生成" }));

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/title`, {},
    ));
    expect(await screen.findByRole("heading", { name: "生成タイトル" })).toBeTruthy();
  });

  it("does not regenerate a title when automatic updates are disabled", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const disabledTask = { ...task, titleAutoUpdate: false, sessionId: "session-1" };
    saveTaskSessionCache({ task: disabledTask, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const sendSnapshot = async (status: "working" | "idle") => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({
            eventType: "ready",
            task: { ...disabledTask, status, isStreaming: status === "working" },
            messages: [],
          }),
        }));
      });
    };
    await sendSnapshot("working");
    await sendSnapshot("idle");

    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it("assigns a label only after the first response without regenerating the title", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const sessionTask = { ...task, sessionId: "session-1", titleAutoUpdate: true };
    const turnMessages = (turns: number): UiMessage[] => Array.from(
      { length: turns * 2 },
      (_, index) => {
        const turn = Math.floor(index / 2) + 1;
        const role = index % 2 === 0 ? "user" : "assistant";
        return {
          id: `${role}-${turn}`,
          role,
          createdAt: turn,
          parts: [{ id: `${role}-${turn}-text`, type: "text", text: `${role} ${turn}` }],
        } as UiMessage;
      },
    );
    saveTaskSessionCache({ task: sessionTask, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const sendSnapshot = async (status: "working" | "idle", turns: number) => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({
            eventType: "ready",
            task: { ...sessionTask, status, isStreaming: status === "working" },
            messages: turnMessages(turns),
          }),
        }));
      });
    };
    for (let turns = 1; turns <= 4; turns += 1) {
      await sendSnapshot("working", turns);
      await sendSnapshot("idle", turns);
    }
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/title`,
      { labelOnly: true },
    );

    await sendSnapshot("working", 5);
    await sendSnapshot("idle", 5);

    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
  });

  it("sends queued content without replacing the next draft", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    const snapshot = async (working: boolean) => {
      await act(async () => {
        TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({ eventType: "ready", task: { ...task, status: working ? "working" : "idle", isStreaming: working }, messages: [] }),
        }));
      });
    };
    await snapshot(true);
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "キュー" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "queued prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "unfinished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "差し込み" }));
    expect(screen.getByRole("button", { name: "差し込みを送信" })).toBeTruthy();
    await snapshot(false);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "queued prompt" }),
    ));
    expect(input.value).toBe("unfinished draft");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBeUndefined();
  });

  it("drains queued content when the current turn ends with an error", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({ task: { ...task, status: "working", isStreaming: true } });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");
    const sendSnapshot = async (status: "working" | "error", error?: string) => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({
            eventType: status,
            task: { ...task, status, isStreaming: status === "working", ...(error ? { error } : {}) },
            messages: [],
            isStreaming: status === "working",
            ...(error ? { error } : {}),
          }),
        }));
      });
    };
    await sendSnapshot("working");
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "キュー" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" });
    fireEvent.change(input, { target: { value: "retry after error" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).not.toHaveBeenCalled();

    await sendSnapshot("error", "current turn failed");
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "retry after error" }),
    ));
  });

  it.each([false, true])("uses steer only while working (working: %s)", async (working) => {
    saveTaskSessionCache({ task: { ...task, status: working ? "working" : "idle" }, messages: [], isStreaming: working, isCompacting: false });
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "差し込み" }));
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
    expect((await screen.findAllByText("変更あり")).length).toBe(1);

    changed = 0;
    await act(async () => {
      window.dispatchEvent(new Event("webui:tasks-changed"));
      await Promise.resolve();
    });
    expect((await screen.findAllByText("クリーン")).length).toBe(1);
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

  it("does not show a stale model error after a newer selection succeeds", async () => {
    const modelTask = { ...task, providerID: "provider", modelID: "a", thinkingLevel: "off" as const };
    const models = ["a", "b", "c"].map((id) => ({
      value: `provider::${id}`, label: `Model ${id.toUpperCase()}`, providerID: "provider", modelID: id,
    }));
    let resolveLatest!: (result: { task: TaskSummary }) => void;
    let rejectOlder!: (reason?: unknown) => void;
    const olderResponse = new Promise<never>((_, reject) => { rejectOlder = reject; });
    const latestResponse = new Promise<{ task: TaskSummary }>((resolve) => { resolveLatest = resolve; });
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    mocks.sendJson.mockImplementation((_path: string, body: { model: string }) =>
      body.model === "provider::b" ? olderResponse : latestResponse,
    );
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "モデル" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model C" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/model`, { model: "provider::c" },
    ));
    await act(async () => {
      resolveLatest({ task: { ...modelTask, modelID: "c" } });
      await latestResponse;
    });
    await act(async () => {
      rejectOlder(new Error("stale model failure"));
      await olderResponse.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model C");
  });

  it("keeps a concrete model after leaving Auto across remount", async () => {
    const modelTask = {
      ...task,
      providerID: "provider",
      modelID: "a",
      thinkingLevel: "off" as const,
    };
    const models = ["a", "b"].map((id) => ({
      value: `provider::${id}`,
      label: `Model ${id.toUpperCase()}`,
      providerID: "provider",
      modelID: id,
    }));
    localStorage.setItem("leafcodepi.defaultModel", "auto");
    sessionStorage.setItem(
      `webui:auto-task:${task.id}`,
      JSON.stringify({
        decision: {
          providerID: "provider",
          modelID: "a",
          variant: "minimal",
          tier: "light",
          mode: "cost",
          reason: "auto",
        },
      }),
    );
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    mocks.sendJson.mockResolvedValue({ task: { ...modelTask, modelID: "b" } });

    const view = render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Auto");
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B"),
    );
    expect(sessionStorage.getItem(`webui:auto-task:${task.id}`)).toBeNull();
    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("provider::b");

    view.unmount();
    saveTaskSessionCache({
      task: { ...modelTask, modelID: "b" },
      messages: [],
      isStreaming: false,
      isCompacting: false,
    });
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B"),
    );
    expect(screen.getByRole("button", { name: "モデル" }).textContent).not.toContain("Auto");
  });

  it("does not inherit Composer Auto default for a concrete-model task", async () => {
    const modelTask = {
      ...task,
      providerID: "provider",
      modelID: "a",
      thinkingLevel: "off" as const,
    };
    const models = [
      {
        value: "provider::a",
        label: "Model A",
        providerID: "provider",
        modelID: "a",
      },
    ];
    localStorage.setItem("leafcodepi.defaultModel", "auto");
    sessionStorage.clear();
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });

    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    expect(screen.getByRole("button", { name: "モデル" }).textContent).not.toContain("Auto");
  });

  it("shows the cached model immediately without waiting for /api/models", async () => {
    const modelTask = {
      ...task,
      providerID: "provider",
      modelID: "a",
      thinkingLevel: "off" as const,
    };
    const models = [
      {
        value: "provider::a",
        label: "Model A",
        providerID: "provider",
        modelID: "a",
      },
    ];
    let resolveModels!: (value: { models: typeof models }) => void;
    const pendingModels = new Promise<{ models: typeof models }>((done) => {
      resolveModels = done;
    });
    writeCachedModels(models);
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockImplementation((url: string) => {
      if (url === "/api/models") return pendingModels;
      if (url === "/api/agents") return Promise.resolve({ agents: [] });
      if (url === "/api/skills") return Promise.resolve({ skills: [] });
      if (url === "/api/accounts") return Promise.resolve({ accounts: [] });
      return Promise.resolve({});
    });

    render(<TaskView taskId={task.id} mdUp />);
    const trigger = screen.getByRole("button", { name: "モデル" });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.textContent).toContain("Model A");
    expect(trigger.textContent).not.toContain("読み込み中");
    expect(trigger.textContent).not.toContain("モデルなし");

    await act(async () => {
      resolveModels({ models });
    });
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
  });

  it("keeps thinking levels when an account model maps to an integrated option", async () => {
    const modelTask = {
      ...task,
      accountId: "acc-1",
      providerID: "provider",
      modelID: "a",
      thinkingLevel: "off" as const,
    };
    const accountModel: ModelOption = {
      value: "acc-1::provider::a",
      label: "Model A",
      providerID: "provider",
      modelID: "a",
      accountId: "acc-1",
      thinkingLevels: ["off", "high"] as const,
    };
    const integratedModel: ModelOption = {
      value: "provider::a",
      label: "Model A",
      providerID: "provider",
      modelID: "a",
      routingMode: "integrated" as const,
      thinkingLevels: ["off", "high"] as const,
    };
    let resolveModels!: (value: { models: Array<typeof integratedModel> }) => void;
    const pendingModels = new Promise<{ models: Array<typeof integratedModel> }>((done) => {
      resolveModels = done;
    });
    writeCachedModels([accountModel]);
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.sendJson.mockResolvedValue({ task: modelTask });
    mocks.getJson.mockImplementation((url: string) => {
      if (url === "/api/models") return pendingModels;
      if (url === "/api/agents") return Promise.resolve({ agents: [] });
      if (url === "/api/skills") return Promise.resolve({ skills: [] });
      if (url === "/api/accounts") return Promise.resolve({ accounts: [] });
      return Promise.resolve({});
    });

    render(<TaskView taskId={task.id} mdUp />);
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    expect(screen.getByRole("button", { name: "思考レベル" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: /Model A/ }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalled());

    await act(async () => {
      resolveModels({ models: [integratedModel] });
    });

    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    expect(screen.getByRole("button", { name: "思考レベル" })).toBeTruthy();
  });

  it("does not inherit Composer Auto agent default for a concrete-agent task", async () => {
    const agentTask = { ...task, agent: "builder" };
    localStorage.setItem("leafcodepi.defaultAgent", "__auto__");
    saveTaskSessionCache({ task: agentTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({
      models: [],
      agents: [{ name: "builder", description: "Builder", enabled: true }],
      skills: [],
      accounts: [],
    });

    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "エージェント" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "エージェント" }).textContent).toContain("builder");
    expect(screen.getByRole("button", { name: "エージェント" }).textContent).not.toMatch(/\bAuto\b/);
  });

  it("does not send on Ctrl+Enter with IME keyCode 229", async () => {
    // compositionStart 欠落時も isImeComposingEvent(keyCode 229) で送信を抑止する。
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft prompt" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, keyCode: 229 });
    expect(mocks.sendJson).not.toHaveBeenCalled();
    expect(input.value).toBe("draft prompt");
  });

  it("clears stuck composition on blur so Ctrl+Enter can send again", async () => {
    // compositionEnd 欠落で composingRef が stuck しても、blur で解除して送信可能にする。
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft prompt" } });
    fireEvent.compositionStart(input);
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(mocks.sendJson).toHaveBeenCalledWith(
        `/api/tasks/${task.id}/prompt`,
        expect.objectContaining({ prompt: "draft prompt" }),
      ),
    );
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
          questionRequest: {
            id: "question-1",
            sessionId: "session-1",
            questions: [{ question: "続けますか？", options: [], custom: true }],
          },
        }),
      }));
    });

    const dialog = await screen.findByRole("alertdialog", { name: "危険なコマンドの確認" });
    const messageNode = dialog.querySelector("p");
    expect(messageNode?.className).toContain("max-h-32");
    expect(messageNode?.className).toContain("overflow-auto");
    expect(screen.getByRole("button", { name: "許可" })).toBeTruthy();
    expect(screen.getByText("承認待ち")).toBeTruthy();
    expect(screen.getByText("回答待ち")).toBeTruthy();
  });

  it("does not revive an answered permission from a stale SSE snapshot", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({});
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const permission = {
      id: "request-1",
      sessionId: "session-1",
      command: "echo test",
      labels: [],
      message: "許可が必要です",
    };
    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
          messages: [],
          permissionRequest: permission,
        }),
      }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "許可" }));
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(`/api/tasks/${task.id}/permission`, {
        requestId: "request-1",
        approved: true,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "許可" })).toBeNull();
    });

    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "remote_poll",
          task: { ...task, sessionId: "session-1", status: "working" },
          permissionRequest: permission,
        }),
      }));
    });
    expect(screen.queryByRole("button", { name: "許可" })).toBeNull();
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
      status: "blocked",
      goal: "keep going",
      acceptance: ["done"],
      maxTurns: 3,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: false,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "確認が必要です",
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
      task: {
        ...task,
        sessionId: "session-1",
        messages: [],
        isStreaming: false,
      },
      messages: [],
      todos: [{ id: "todo-1", content: "確認", status: "in_progress", priority: "high" }],
      goalLoop,
    });
    const todoPanel = await screen.findByRole("region", { name: "ToDo進捗" });
    const goalLoopPanel = await screen.findByRole("region", { name: "Goal loop" });
    expect(todoPanel.parentElement).toBe(goalLoopPanel.parentElement);
    expect(todoPanel.compareDocumentPosition(goalLoopPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "再開" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "フォローアップ" }).querySelector('[aria-label="Goal loop"]')).toBeNull();

    await sendSnapshot({
      eventType: "restored",
      task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
      messages: [],
      goalLoop: null,
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Goal loop" })).toBeNull());
  });
});

it("stops task reading aloud when the task TTS toggle is turned off mid-playback", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource | null = null;

    constructor() {
      super();
      TestEventSource.latest = this;
    }

    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const ttsFetch = vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 }));
  const play = vi.fn(async () => undefined);
  const pause = vi.fn();
  vi.stubGlobal("fetch", ttsFetch);
  vi.stubGlobal("Audio", class {
    onended: (() => void) | null = null;
    playbackRate = 1;
    volume = 1;
    play = play;
    pause = pause;
  });
  localStorage.setItem("webui:tts-enabled:draft-task", "1");
  localStorage.setItem("webui:notification-sound-volume", "0");
  const oldReply: UiMessage = { id: "old", role: "assistant", createdAt: 1, parts: [{ id: "old-text", type: "text", text: "古い返信" }] };
  const newReply: UiMessage = { id: "new", role: "assistant", createdAt: 2, parts: [{ id: "new-text", type: "text", text: "新しい返信" }] };
  saveTaskSessionCache({ task, messages: [oldReply], isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);
  const source = TestEventSource.latest;
  if (!source) throw new Error("EventSource was not created");
  const sendSnapshot = async (payload: unknown) => {
    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(payload) }));
    });
  };
  await sendSnapshot({ task: { ...task, status: "working" }, messages: [oldReply] });
  await sendSnapshot({ task: { ...task, status: "idle" }, messages: [oldReply, newReply] });
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  const ttsCall = (ttsFetch.mock.calls as unknown as Array<[string, RequestInit]>).find(([url]) => String(url).includes("/api/tts/synthesize"));
  expect(ttsCall).toBeTruthy();
  expect(JSON.parse(String(ttsCall![1].body))).toEqual({ text: "新しい返信" });
  // タスク側でOFF → 共有キーの通知で再生中の音声を止める。
  act(() => { writeTaskTtsEnabled(task.id, false); });
  expect(pause).toHaveBeenCalledTimes(1);
});

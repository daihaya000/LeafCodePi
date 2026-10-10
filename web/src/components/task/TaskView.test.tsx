// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { ModelOption, TaskSummary, UiMessage, UiPart } from "@/lib/types";
import { COMPACTION_ACTION_SETTING_KEY } from "@/lib/compaction-settings";
import { DEFAULT_SESSION_LABELS } from "@/lib/session-label-settings";
import { setNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";

const mocks = vi.hoisted(() => {
  const sendJson = vi.fn();
  return {
    getJson: vi.fn(), sendJson,
    sendTaskPrompt: vi.fn((path: string, body: unknown) => sendJson(path, body)),
    apiUrl: (path: string) => path,
    partView: vi.fn(), toolCard: vi.fn(), messageMetaHeader: vi.fn(), workingRow: vi.fn(() => null),
    markRead: vi.fn(), botFor: vi.fn(), iconFor: vi.fn(),
  };
});
vi.mock("@/lib/client", () => mocks);
vi.mock("@/lib/bot-unread", () => ({ markRead: mocks.markRead }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({ PartView: mocks.partView, ToolCard: mocks.toolCard, MessageMetaHeader: mocks.messageMetaHeader, WorkingRow: mocks.workingRow }));
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
  setNotificationDeliveryEnabled(true);
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
  setNotificationDeliveryEnabled(true);
  vi.unstubAllGlobals();
  localStorage.clear();
  clearCachedModels();
});

it("restores the owner's authoritative rewind text rather than the cached message projection", async () => {
  const message: UiMessage = { id: "user-input", role: "user", createdAt: 1, parts: [{ id: "text", type: "text", text: "stale cached projection" }] };
  saveTaskSessionCache({ task, messages: [message], isStreaming: false, isCompacting: false });
  mocks.partView.mockImplementation(({ message: item, onRevert }: { message: UiMessage; onRevert?: (message: UiMessage) => void }) =>
    <button onClick={() => onRevert?.(item)}>Restore input</button>);
  mocks.sendJson.mockResolvedValue({ task: { ...task, messages: [], revertLeafId: "original", isStreaming: false }, text: "authoritative user input", images: [], files: [] });
  render(<TaskView taskId={task.id} mdUp />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore input" }));
  fireEvent.click(screen.getByRole("button", { name: "巻き戻す" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement).value).toBe("authoritative user input"));
});

it("shares the footer notification switch with Code task browser notifications", async () => {
  const sent: string[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    constructor(title: string) { sent.push(title); }
  }
  class TestEventSource extends EventTarget {
    static latest: TestEventSource;
    constructor() { super(); TestEventSource.latest = this; }
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("EventSource", TestEventSource);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  setNotificationDeliveryEnabled(false);
  try {
    render(<TaskView taskId={task.id} mdUp />);
    const snapshot = async (status: "working" | "idle") => {
      await act(async () => {
        TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({ eventType: "ready", task: { ...task, status, isStreaming: status === "working" }, messages: [] }),
        }));
      });
    };
    await snapshot("working");
    await snapshot("idle");
    expect(sent).toEqual([]);
    act(() => setNotificationDeliveryEnabled(true));
    expect(sent).toEqual([]);
    await snapshot("working");
    await snapshot("idle");
    expect(sent).toHaveLength(1);
  } finally {
    Reflect.deleteProperty(document, "hidden");
  }
});

it("applies state updates when an SSE snapshot reuses the current task summary", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource;
    constructor() { super(); TestEventSource.latest = this; }
    close() {}
  }
  const messages: UiMessage[] = [
    { id: "prompt", role: "user", createdAt: 1, parts: [{ id: "text", type: "text", text: "指示" }] },
  ];
  const cachedTask = { ...task, sessionId: "session-1" };
  saveTaskSessionCache({ task: cachedTask, messages, isStreaming: false, isCompacting: false });
  vi.stubGlobal("EventSource", TestEventSource);
  render(<TaskView taskId={task.id} mdUp />);
  await waitFor(() => expect(TestEventSource.latest).toBeTruthy());

  await act(async () => {
    TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({ eventType: "ready", task: cachedTask, messages, isStreaming: false }),
    }));
  });
  expect(screen.getByRole("button", { name: "次の指示を提案" })).toBeTruthy();

  await act(async () => {
    TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({ eventType: "remote_poll", taskReused: true, isStreaming: true, isCompacting: false }),
    }));
  });
  expect(screen.getByRole("button", { name: "進捗を確認" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "次の指示を提案" })).toBeNull();
});

it.each([true, false])("shows the Pi session ID only at the top of the Diff panel (mdUp: %s)", async (mdUp) => {
  const sessionId = "01a0efee-1234-5678-9012-123456789abc";
  saveTaskSessionCache({ task: { ...task, sessionId, directory: "C:\\repo" }, messages: [], isStreaming: false, isCompacting: false });
  mocks.getJson.mockImplementation(() => Promise.resolve({ files: [], git: true, additions: 0, deletions: 0, models: [], agents: [], skills: [], accounts: [] }));
  render(<TaskView taskId={task.id} mdUp={mdUp} />);
  const label = "PiセッションID（クリックでコピー、ドラッグで選択）";
  expect(screen.queryByRole("textbox", { name: label })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Diff パネル" }));
  const trigger = await screen.findByRole("textbox", { name: label }) as HTMLInputElement;
  expect(trigger.readOnly).toBe(true);
  expect(trigger.value).toBe(sessionId);
  const row = trigger.parentElement!;
  expect(row.getAttribute("aria-label")).toBe("セッション識別情報");
  expect(row.parentElement?.firstElementChild).toBe(row);
  expect(screen.getByRole("form", { name: "フォローアップ" }).contains(trigger)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Diff パネル" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: label })).toBeNull());
});

it("shows the next-action suggestion above the follow-up composer", async () => {
  saveTaskSessionCache({
    task: { ...task, sessionId: "session-1" },
    messages: [],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.sendJson.mockResolvedValue({ suggestion: "次にテストを追加する" });
  render(<TaskView taskId={task.id} mdUp />);

  const trigger = await screen.findByRole("button", { name: "次の指示を提案" });
  fireEvent.click(trigger);
  const panel = await screen.findByRole("region", { name: "次の指示の提案" });
  expect(await screen.findByText("次にテストを追加する")).toBeTruthy();
  const composer = screen.getByRole("form", { name: "フォローアップ" });
  expect(composer.contains(trigger)).toBe(false);
  expect(panel.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "次の指示の提案" })).toBeNull();
});

it.each([
  { status: "idle", isStreaming: false, visible: "次の指示を提案", hidden: "進捗を確認" },
  { status: "working", isStreaming: false, visible: "進捗を確認", hidden: "次の指示を提案" },
  { status: "idle", isStreaming: true, visible: "進捗を確認", hidden: "次の指示を提案" },
] as const)("shows only $visible below the navigator (status: $status, streaming: $isStreaming)", async ({ status, isStreaming, visible, hidden }) => {
  const messages: UiMessage[] = [
    { id: "prompt", role: "user", createdAt: 1, parts: [{ id: "text", type: "text", text: "指示" }] },
  ];
  saveTaskSessionCache({ task: { ...task, sessionId: "session-1", status }, messages, isStreaming, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  const control = await screen.findByRole("button", { name: visible });
  expect(screen.queryByRole("button", { name: hidden })).toBeNull();
  const firstMessage = screen.getByRole("button", { name: "最初のユーザーメッセージへ" });
  const navigator = firstMessage.parentElement;
  expect(navigator?.classList.contains("gap-2")).toBe(true);
  expect(navigator?.parentElement?.classList.contains("gap-6")).toBe(true);
  const searchButton = screen.getByRole("button", { name: "セッション内を検索" });
  expect(navigator?.parentElement?.firstElementChild?.contains(searchButton)).toBe(true);
  expect(searchButton.compareDocumentPosition(firstMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(navigator?.parentElement?.parentElement?.lastElementChild?.contains(control)).toBe(true);
  expect(navigator?.parentElement?.classList.contains("overflow-y-auto")).toBe(true);
  expect(navigator?.parentElement?.parentElement?.className).toContain("max-h-[calc(100%-2rem)]");
  expect(screen.getByRole("form", { name: "フォローアップ" }).contains(control)).toBe(false);
});

it("keeps the progress answer when a mobile side panel is opened and closed", async () => {
  saveTaskSessionCache({
    task: { ...task, sessionId: "session-1", status: "working" }, messages: [], isStreaming: true, isCompacting: false,
  });
  mocks.sendJson.mockResolvedValue({ answer: "確認した進捗", snapshotAt: Date.now(), working: true });
  render(<TaskView taskId={task.id} mdUp={false} />);

  fireEvent.click(await screen.findByRole("button", { name: "進捗を確認" }));
  expect(await screen.findByText("確認した進捗")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "コミットグラフ" }));
  expect(screen.getByRole("button", { name: "進捗の確認を表示" }).closest(".absolute")?.classList.contains("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "コミットグラフ" }));

  expect(screen.getByRole("button", { name: "進捗の確認を表示" }).closest(".absolute")?.classList.contains("hidden")).toBe(false);
  expect(screen.getByText("確認した進捗")).toBeTruthy();
  expect(mocks.sendJson).toHaveBeenCalledTimes(1);
});

it("keeps the suggestion when a mobile side panel is opened and closed", async () => {
  saveTaskSessionCache({
    task: { ...task, sessionId: "session-1" }, messages: [], isStreaming: false, isCompacting: false,
  });
  mocks.sendJson.mockResolvedValue({ suggestion: "次にテストを追加する" });
  render(<TaskView taskId={task.id} mdUp={false} />);

  fireEvent.click(await screen.findByRole("button", { name: "次の指示を提案" }));
  expect(await screen.findByText("次にテストを追加する")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "コミットグラフ" }));
  expect(screen.getByRole("button", { name: "提案を表示" }).closest(".absolute")?.classList.contains("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "コミットグラフ" }));

  expect(screen.getByText("次にテストを追加する")).toBeTruthy();
  expect(mocks.sendJson).toHaveBeenCalledTimes(1);
});

it("runs scroll pinning only for active visible task panes", () => {
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const setIntervalSpy = vi.spyOn(window, "setInterval");
  const clearIntervalSpy = vi.spyOn(window, "clearInterval");
  vi.stubGlobal("ResizeObserver", undefined);
  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  };
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const view = render(<TaskView taskId={task.id} mdUp active={false} />);
    const pinTimers = () => setIntervalSpy.mock.calls
      .map((call, index) => ({ delay: call[1], id: setIntervalSpy.mock.results[index]?.value }))
      .filter((timer) => timer.delay === 200);
    expect(pinTimers()).toHaveLength(0);

    view.rerender(<TaskView taskId={task.id} mdUp active />);
    expect(pinTimers()).toHaveLength(1);
    const firstTimer = pinTimers()[0]!.id;
    setVisibility("hidden");
    expect(clearIntervalSpy).toHaveBeenCalledWith(firstTimer);

    setVisibility("visible");
    expect(pinTimers()).toHaveLength(2);
    const resumedTimer = pinTimers()[1]!.id;
    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(resumedTimer);
  } finally {
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  }
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

it("displays the project icon at the start of the status row", async () => {
  const projectTask = { ...task, projectId: "project-1" };
  const icon = <span data-testid="project-icon" />;
  mocks.iconFor.mockReturnValue(icon);
  saveTaskSessionCache({ task: projectTask, messages: [], isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  const projectIcon = await screen.findByTestId("project-icon");
  const title = screen.getByRole("heading", { name: projectTask.title });
  const status = screen.getByLabelText("タスクの状態");
  expect(status.firstElementChild?.firstElementChild).toBe(projectIcon);
  expect(title.compareDocumentPosition(projectIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mocks.iconFor).toHaveBeenCalledWith(task.id, 24, expect.objectContaining({ projectId: "project-1" }));
});

it("allows the running status badge to shrink within the header", async () => {
  saveTaskSessionCache({ task: { ...task, status: "working" }, messages: [], isStreaming: true, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);
  const status = screen.getByLabelText("タスクの状態");
  const badge = within(status).getByText("実行中").parentElement!.parentElement!;
  expect(badge.className).toContain("min-w-0");
  expect(badge.className).not.toContain("shrink-0");
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

it("echoes a submitted prompt until the authoritative SSE message replaces it, never both", async () => {
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
  expect(mocks.sendTaskPrompt).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/prompt`,
    expect.objectContaining({ prompt: "同じ指示" }),
    65_000,
  );
  // The local echo shows at once (outside the transcript state) ...
  await waitFor(() => expect(document.querySelectorAll("[data-task-message]")).toHaveLength(1));
  expect(document.querySelector("[data-task-message]")?.getAttribute("data-task-message")).toMatch(/^optimistic-user:/);

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

  // ... and the authoritative row replaces it in the same commit: never a duplicate.
  await waitFor(() => expect(document.querySelector("[data-task-message]")?.getAttribute("data-task-message")).toBe("entry-42"));
  expect(document.querySelectorAll("[data-task-message]")).toHaveLength(1);
  expect(document.querySelector("[data-task-message]")?.textContent).toBe("同じ指示");
});

it("queues a Goal loop follow-up first, then injects it only on immediate send", async () => {
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
        task: { ...task, status: "working", isStreaming: true },
        goalLoop: { id: "loop-1", status: "running", goal: "目標", acceptance: ["ok"], maxTurns: 5, turnCount: 1, progress: [] },
        messages: [],
        isStreaming: true,
      }),
    }));
    await Promise.resolve();
  });

  const input = screen.getByRole("textbox", { name: "フォローアップ" });
  fireEvent.change(input, { target: { value: "追加の指示" } });
  fireEvent.click(screen.getByRole("button", { name: "キューに追加" }));
  expect(mocks.sendJson).not.toHaveBeenCalled();
  expect(screen.getByText("追加の指示")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "即時送信: 追加の指示" }));

  // 二段階目だけが実行中ターンへ差し込み、Goal loop は止めない。
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/prompt`,
    expect.objectContaining({ prompt: "追加の指示", streamingBehavior: "steer" }),
  ));
  expect(screen.queryByText("Goal loop の実行中は追加の送信はできません")).toBeNull();
});

it("holds the default queue until a Goal loop releases the session", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource;
    constructor() { super(); TestEventSource.latest = this; }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.sendJson.mockResolvedValue({ task });
  render(<TaskView taskId={task.id} mdUp />);
  const snapshot = async (status: "working" | "idle", loopStatus: "running" | "completed") => {
    const goalLoop = { id: "loop-1", status: loopStatus, goal: "goal", acceptance: [], maxTurns: 5, turnCount: 1, progress: [] };
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, status, isStreaming: status === "working" },
          goalLoop,
          messages: [],
        }),
      }));
    });
  };
  await snapshot("working", "running");
  fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "after loop" } });
  fireEvent.click(screen.getByRole("button", { name: "キューに追加" }));
  await snapshot("idle", "running");
  expect(mocks.sendJson).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "即時送信: after loop" }) as HTMLButtonElement).disabled).toBe(true);
  await snapshot("idle", "completed");
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "after loop" }),
  ));
  expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBeUndefined();
});

it("keeps a queued follow-up until a blocking revert confirmation closes", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource;
    constructor() { super(); TestEventSource.latest = this; }
    close() {}
  }
  const userMessage: UiMessage = {
    id: "queued-revert-user",
    role: "user",
    createdAt: 1,
    parts: [{ id: "queued-revert-text", type: "text", text: "previous prompt" }],
  };
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.partView.mockImplementation(({ message, onRevert }: {
    message: UiMessage;
    onRevert?: (message: UiMessage) => void;
  }) => message.role === "user"
    ? <button type="button" onClick={() => onRevert?.(message)}>Revert message</button>
    : null);
  mocks.sendJson.mockResolvedValue({ task: { ...task, status: "working" } });
  render(<TaskView taskId={task.id} mdUp />);
  const snapshot = async (status: "working" | "idle", loopStatus: "running" | "paused" | "completed") => {
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, status, isStreaming: status === "working" },
          goalLoop: { id: "loop-1", status: loopStatus, goal: "goal", acceptance: [], maxTurns: 5, turnCount: 1, progress: [] },
          messages: [userMessage],
        }),
      }));
    });
  };

  await snapshot("working", "running");
  fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "after loop" } });
  fireEvent.click(screen.getByRole("button", { name: "キューに追加" }));
  await snapshot("idle", "paused");
  fireEvent.click(screen.getByRole("button", { name: "Revert message" }));
  expect(screen.getByRole("alertdialog", { name: "巻き戻しの確認" })).toBeTruthy();

  await snapshot("idle", "completed");
  expect(mocks.sendJson).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "即時送信: after loop" })).toBeTruthy();

  fireEvent.click(within(screen.getByRole("alertdialog", { name: "巻き戻しの確認" })).getByRole("button", { name: "キャンセル" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "after loop" }),
  ));
  expect(mocks.sendJson).toHaveBeenCalledTimes(1);
});

it("drops queued follow-ups when a Goal loop is stopped", async () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource;
    constructor() { super(); TestEventSource.latest = this; }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  render(<TaskView taskId={task.id} mdUp />);
  await act(async () => {
    TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({
        eventType: "ready", task: { ...task, status: "working", isStreaming: true },
        goalLoop: { id: "loop-1", status: "running", goal: "goal", acceptance: [], maxTurns: 5, turnCount: 1, progress: [] },
        messages: [],
      }),
    }));
  });
  fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "do not send" } });
  fireEvent.click(screen.getByRole("button", { name: "キューに追加" }));
  mocks.sendJson.mockResolvedValueOnce({ loop: { id: "loop-1", status: "stopped", progress: [] } });
  const panel = screen.getByRole("region", { name: "Goal loop" });
  const stop = panel.querySelector('button[aria-label="停止"]');
  if (!stop) throw new Error("Goal loop stop button missing");
  fireEvent.click(stop);
  await waitFor(() => expect(screen.queryByRole("button", { name: "即時送信: do not send" })).toBeNull());
  expect(mocks.sendJson).toHaveBeenCalledWith(`/api/tasks/${task.id}/goal-loop`, { action: "stop" }, "PATCH");
  expect(mocks.sendJson).toHaveBeenCalledTimes(1);
});

describe("Goal Loop halt feedback", () => {
  class TestEventSource extends EventTarget {
    static latest: TestEventSource;
    constructor() { super(); TestEventSource.latest = this; }
    close() {}
  }
  const streamingTail: UiMessage[] = [
    { id: "u1", role: "user", createdAt: 1, parts: [{ id: "u1-t", type: "text", text: "go" }] },
    { id: "a1", role: "assistant", createdAt: 2, parts: [{ id: "a1-t", type: "text", text: "書いています" }] },
  ];
  const lastWorkingRowLabel = () => {
    const calls = mocks.workingRow.mock.calls as unknown as [{ label?: string }][];
    return calls.at(-1)?.[0]?.label;
  };
  const workingSnapshot = async (extra: Record<string, unknown> = {}) => {
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, status: "working", isStreaming: true },
          goalLoop: { id: "loop-1", status: "running", goal: "goal", acceptance: [], maxTurns: 5, turnCount: 1, progress: [] },
          messages: streamingTail,
          ...extra,
        }),
      }));
    });
  };

  it("keeps the WorkingRow up with a pause label while streaming text, and drops the permission card", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    let resolvePause!: (value: unknown) => void;
    mocks.sendJson.mockImplementation(() => new Promise((resolve) => { resolvePause = resolve; }));
    render(<TaskView taskId={task.id} mdUp />);
    await workingSnapshot({
      permissionRequest: { id: "perm-1", sessionId: "session-1", command: "rm x", labels: [], message: "許可が必要です" },
    });
    // Streaming text tail hides the row before any halt.
    mocks.workingRow.mockClear();
    expect(await screen.findByText(/許可待ちです/)).toBeTruthy();
    const pause = within(screen.getByRole("region", { name: "Goal loop" })).getByRole("button", { name: "一時停止" });
    fireEvent.click(pause);
    await waitFor(() => expect(lastWorkingRowLabel()).toBe("Goal Loop を一時停止しています…"));
    await act(async () => { resolvePause({ loop: { id: "loop-1", status: "paused", goal: "goal", acceptance: [], maxTurns: 5, turnCount: 1, progress: [], pauseReason: "user" } }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "許可" })).toBeNull());
  });

  it("shows composer Stop feedback even while text streams", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockImplementation(() => new Promise(() => {}));
    render(<TaskView taskId={task.id} mdUp />);
    await workingSnapshot({ goalLoop: null });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(lastWorkingRowLabel()).toBe("停止しています…"));
  });

  it("resyncs the panel and stays quiet when a Pause loses the race to the loop completing", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockRejectedValue(new Error("Goal Loop の操作が反映されませんでした"));
    const fallbackGetJson = mocks.getJson.getMockImplementation();
    mocks.getJson.mockImplementation((path: string, ...rest: unknown[]) => path === `/api/tasks/${task.id}/goal-loop`
      ? Promise.resolve({ loop: { id: "loop-1", status: "completed", goal: "goal", acceptance: [], maxTurns: 5, turnCount: 5, progress: [] } })
      : fallbackGetJson?.(path, ...rest));
    render(<TaskView taskId={task.id} mdUp />);
    await workingSnapshot();
    fireEvent.click(within(screen.getByRole("region", { name: "Goal loop" })).getByRole("button", { name: "一時停止" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Goal Loop は既に完了しています");
    // completed is not session-owned: the stale running panel is gone.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Goal loop" })).toBeNull());
  });
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

it("skips hidden-page deltas and resyncs the latest snapshot when visible", async () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  class TestEventSource extends EventTarget {
    static sources: TestEventSource[] = [];
    constructor(readonly url: string) { super(); TestEventSource.sources.push(this); }
    close() {}
  }
  const message: UiMessage = {
    id: "hidden-stream-message",
    role: "assistant",
    createdAt: 1,
    parts: [{ id: "hidden-stream-text", type: "text", text: "latest hidden output" }],
  };
  vi.stubGlobal("EventSource", TestEventSource);
  mocks.partView.mockImplementation(({ message: item }: { message: UiMessage }) => (
    <div data-task-message={item.id}>{item.parts[0]?.type === "text" ? item.parts[0].text : ""}</div>
  ));
  try {
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => expect(TestEventSource.sources).toHaveLength(1));
    expect(TestEventSource.sources[0]!.url).toContain("streamDeltas=1");
    expect(TestEventSource.sources[0]!.url).toContain("streamMessages=1");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(TestEventSource.sources).toHaveLength(2));
    const hiddenSource = TestEventSource.sources[1]!;
    expect(hiddenSource.url).toContain("streamDeltas=0");
    expect(hiddenSource.url).toContain("streamMessages=0");
    await act(async () => {
      hiddenSource.dispatchEvent(new MessageEvent("delta", { data: JSON.stringify({ message }) }));
      hiddenSource.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "remote_poll",
          task: { ...task, status: "working", isStreaming: true },
          messages: [message],
          isStreaming: true,
        }),
      }));
      await Promise.resolve();
    });
    expect(screen.queryByText("latest hidden output")).toBeNull();

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(TestEventSource.sources).toHaveLength(3));
    expect(TestEventSource.sources[2]!.url).toContain("streamDeltas=1");
    expect(TestEventSource.sources[2]!.url).toContain("streamMessages=1");
    await act(async () => {
      TestEventSource.sources[2]!.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, status: "working", isStreaming: true },
          messages: [message],
          isStreaming: true,
        }),
      }));
      await Promise.resolve();
    });
    expect(screen.getByText("latest hidden output")).toBeTruthy();
  } finally {
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    else Reflect.deleteProperty(document, "hidden");
  }
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

it("shows a lone finished assistant error without wrapping it in a work log", () => {
  saveTaskSessionCache({
    task,
    messages: [{ id: "failed", role: "assistant", createdAt: 2, error: "認証に失敗", parts: [] }],
    isStreaming: false,
    isCompacting: false,
  });
  mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => <div data-activity-error={message.error} />);
  mocks.messageMetaHeader.mockImplementation(({ message }: { message: UiMessage }) => <div data-task-meta={message.id} />);
  render(<TaskView taskId={task.id} mdUp />);

  expect(document.querySelector("details[data-task-tool-group]")).toBeNull();
  expect(document.querySelector('[data-activity-error="認証に失敗"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-task-meta="failed"]')).toHaveLength(1);
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
  expect(group!.querySelector("summary")?.textContent).toBe("作業ログ2件");
  // Elapsed spans the first start (2.0s) to the last end (5.0s), not the 2s sum; the header shows it.
  const logHeaders = mocks.messageMetaHeader.mock.calls.filter(([props]) => props.usage).map(([props]) => props);
  expect(logHeaders.length).toBeGreaterThanOrEqual(2);
  expect(logHeaders[0].usage).toEqual({ outputTokens: 0, avgRate: null, elapsedMs: 3_000 });
  expect(logHeaders.every((props) => props.singleLine)).toBe(true);
  expect(logHeaders.every((props) => props.showAccountInSingleLine)).toBe(true);
  // 枠外は吹き出し幅に揃え、枠内は枠幅いっぱいを使う。
  expect(logHeaders.map((props) => props.bubbleAligned)).toContain(true);
  expect(logHeaders.map((props) => props.bubbleAligned)).toContain(false);
  expect(group!.previousElementSibling?.className).toContain("max-w-full");
  expect(group!.querySelector("[data-task-meta]")?.parentElement?.className).toContain("@container/meta-header");
  expect(group!.querySelector("[data-task-meta]")?.parentElement?.className).toContain("max-w-full");
  expect(mocks.messageMetaHeader.mock.calls.find(([props]) => props.message.id === "tool-2")?.[0]).toMatchObject({ singleLine: true, showAccountInSingleLine: true });
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

it("uses the picker model name in every Code message metadata placement", async () => {
  const option: ModelOption = {
    value: "account-a::anthropic::claude-sonnet-5-5", label: "Claude Sonnet 5.5",
    providerID: "anthropic", modelID: "claude-sonnet-5-5", accountId: "account-a",
  };
  const toolMessage = (id: string, createdAt: number): UiMessage => ({
    id, role: "assistant", createdAt, provider: "anthropic", model: "claude-sonnet-5-5", accountId: "account-a",
    parts: [{ id: `${id}-tool`, type: "tool", tool: "read", callID: id, state: { status: "completed", input: {} } }],
  });
  saveTaskSessionCache({
    task, messages: [toolMessage("first-tool", 1), toolMessage("next-tool", 2), {
      id: "reply", role: "assistant", createdAt: 3, provider: "anthropic", model: "claude-sonnet-5-5", accountId: "account-a",
      parts: [{ id: "reply-text", type: "text", text: "完了" }],
    }], isStreaming: false, isCompacting: false,
  });
  const originalGetJson = mocks.getJson.getMockImplementation()!;
  mocks.getJson.mockImplementation((path: string) => path === "/api/models"
    ? Promise.resolve({ models: [option] }) : originalGetJson(path));
  render(<TaskView taskId={task.id} mdUp />);

  await waitFor(() => {
    expect(mocks.getJson).toHaveBeenCalledWith("/api/models");
    for (const id of ["first-tool", "next-tool"]) {
      const headers = mocks.messageMetaHeader.mock.calls.filter(([props]) => props.message.id === id);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.at(-1)?.[0].modelLabel).toBe(option.label);
    }
    const firstHeaders = mocks.messageMetaHeader.mock.calls.filter(([props]) => props.message.id === "first-tool" && props.modelLabel === option.label);
    expect(firstHeaders.some(([props]) => props.bubbleAligned === true)).toBe(true);
    expect(firstHeaders.some(([props]) => props.bubbleAligned === false)).toBe(true);
    const reply = mocks.partView.mock.calls.filter(([props]) => props.message.id === "reply").at(-1)?.[0];
    expect(reply?.modelLabel).toBe(option.label);
  });
});

it.each([
  { enabled: ["default"], autoEnabled: false, hideDefault: true },
  { enabled: ["default", "reviewer"], autoEnabled: false, hideDefault: false },
  { enabled: ["default"], autoEnabled: true, hideDefault: false },
])("hides default only in message metadata with one choice ($enabled, Auto: $autoEnabled)", async ({ enabled, autoEnabled, hideDefault }) => {
  const agentTask = { ...task, agent: "default" };
  const messages: UiMessage[] = [
    {
      id: "tool-meta", role: "assistant", agent: "default", createdAt: 1,
      parts: [{ id: "tool-part", type: "tool", tool: "read", callID: "call-1", state: { status: "completed", input: { path: "README.md" } } }],
    },
    {
      id: "tool-meta-next", role: "assistant", agent: "default", createdAt: 2,
      parts: [{ id: "next-tool-part", type: "tool", tool: "grep", callID: "call-2", state: { status: "completed", input: { pattern: "default" } } }],
    },
    { id: "default-reply", role: "assistant", agent: "default", createdAt: 3, parts: [{ id: "reply-text", type: "text", text: "done" }] },
    { id: "old-reply", role: "assistant", agent: "reviewer", createdAt: 4, parts: [{ id: "old-text", type: "text", text: "reviewed" }] },
  ];
  saveTaskSessionCache({ task: agentTask, messages, isStreaming: false, isCompacting: false });
  const originalGetJson = mocks.getJson.getMockImplementation()!;
  let resolveAgents!: (value: { agents: { name: string; enabled: boolean }[]; autoEnabled: boolean }) => void;
  const pendingAgents = new Promise<{ agents: { name: string; enabled: boolean }[]; autoEnabled: boolean }>((resolve) => {
    resolveAgents = resolve;
  });
  mocks.getJson.mockImplementation((path: string) =>
    path === "/api/agents" ? pendingAgents : originalGetJson(path),
  );
  render(<TaskView taskId={task.id} mdUp />);
  await act(async () => {
    resolveAgents({ agents: enabled.map((name) => ({ name, enabled: true })), autoEnabled });
    await pendingAgents;
  });

  const lastProps = (calls: unknown[][], id: string) =>
    calls.filter(([props]) => (props as { message: UiMessage }).message.id === id).at(-1)?.[0];
  const logHeader = lastProps(mocks.messageMetaHeader.mock.calls, "tool-meta");
  const nextLogHeader = lastProps(mocks.messageMetaHeader.mock.calls, "tool-meta-next");
  const reply = lastProps(mocks.partView.mock.calls, "default-reply");
  const historical = lastProps(mocks.partView.mock.calls, "old-reply");
  expect(logHeader).toMatchObject({ agent: "default", hideDefaultAgent: hideDefault });
  expect(nextLogHeader).toMatchObject({ agent: "default", hideDefaultAgent: hideDefault });
  expect(reply).toMatchObject({ agent: "default", hideDefaultAgent: hideDefault });
  expect(historical).toMatchObject({ agent: "reviewer", hideDefaultAgent: hideDefault });
});

it("opens only the latest work log while the task is running", () => {
  const toolMessage = (id: string, createdAt: number): UiMessage => ({
    id, role: "assistant", createdAt,
    parts: [{ id: `${id}-tool`, type: "tool", tool: "read", callID: id, state: { status: "completed", input: {} } }],
  });
  saveTaskSessionCache({
    task: { ...task, status: "working" },
    messages: [toolMessage("old", 1), { id: "prompt", role: "user", createdAt: 2, parts: [{ id: "text", type: "text", text: "続けて" }] }, toolMessage("latest", 3)],
    isStreaming: true,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);
  const logs = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(logs).toHaveLength(1);
  expect(logs[0]!.open).toBe(true);
});

it("keeps the current log expanded when the same response also has a reply bubble", () => {
  saveTaskSessionCache({
    task: { ...task, status: "working" },
    messages: [{ id: "reply", role: "assistant", createdAt: 1, parts: [
      { id: "thought", type: "thinking", text: "確認中" },
      { id: "text", type: "text", text: "回答中" },
    ] }],
    isStreaming: true,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);
  expect(document.querySelector<HTMLDetailsElement>("details[data-task-tool-group]")?.open).toBe(true);
});

it("marks only the latest unfinished reasoning as active in the work log", () => {
  const old: UiMessage = { id: "old-thought", role: "assistant", createdAt: 1, parts: [{ id: "old-part", type: "thinking", text: "前の思考" }] };
  const current: UiMessage = { id: "current-thought", role: "assistant", createdAt: 3, parts: [
    { id: "current-part", type: "thinking", text: "現在の思考" },
    { id: "current-answer", type: "text", text: "回答中" },
  ] };
  const latest: UiMessage = { id: "latest-thought", role: "assistant", createdAt: 4, parts: [{ id: "latest-part", type: "thinking", text: "続きの思考" }] };
  saveTaskSessionCache({
    task: { ...task, status: "working" },
    messages: [old, { id: "prompt", role: "user", createdAt: 2, parts: [{ id: "prompt-text", type: "text", text: "続けて" }] }, current, latest],
    isStreaming: true,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);
  const reasoningFlag = (id: string) => mocks.partView.mock.calls.find(([props]) => props.message.id === id && props.hideMeta)?.[0].reasoningActive;
  expect(reasoningFlag("old-thought")).toBe(false);
  expect(reasoningFlag("current-thought")).toBe(false);
  expect(reasoningFlag("latest-thought")).toBe(true);
});

it("does not mark a failed Code work log as completed when its reply has a bubble", () => {
  saveTaskSessionCache({
    task,
    messages: [{ id: "failed", role: "assistant", createdAt: 1, error: "失敗", parts: [
      { id: "tool", type: "tool", tool: "read", callID: "call", state: { status: "completed", input: {} } },
      { id: "text", type: "text", text: "調査しました。".repeat(80) },
    ] }],
    isStreaming: false,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);
  expect(document.querySelector('details[data-task-tool-group] summary [role="img"][aria-label="エラー"]')).not.toBeNull();
});

it("marks a Code work log successful after a later tool recovers from an error", () => {
  saveTaskSessionCache({
    task,
    messages: [
      { id: "failed", role: "assistant", createdAt: 1, error: "一時失敗", parts: [
        { id: "failed-tool", type: "tool", tool: "read", callID: "failed", state: { status: "error", input: {} } },
      ] },
      { id: "retry", role: "assistant", createdAt: 2, parts: [
        { id: "success-tool", type: "tool", tool: "read", callID: "success", state: { status: "completed", input: {} } },
      ] },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);
  const logs = document.querySelectorAll<HTMLDetailsElement>("details[data-task-tool-group]");
  expect(logs).toHaveLength(1);
  expect(logs[0]!.querySelector('summary [role="img"][aria-label="完了"]')).not.toBeNull();
});

it("summarizes usage only for work-log responses whose headers stay in the log", () => {
  const tool = (id: string, startedAtMs: number): UiPart => ({
    id,
    type: "tool",
    tool: "read",
    callID: `${id}-call`,
    state: { status: "completed", input: { path: "README.md" }, startedAtMs, endedAtMs: startedAtMs + 1_000 },
  });
  saveTaskSessionCache({
    task,
    messages: [
      { id: "user-1", role: "user", createdAt: 9_000, parts: [{ id: "user-1-part", type: "text", text: "確認して" }] },
      { id: "a1", role: "assistant", createdAt: 10_000, responseDurationMs: 2_000, outputTokens: 1_000, tokensPerSecond: 20, parts: [tool("a1-tool", 12_000)] },
      {
        id: "a2",
        role: "assistant",
        createdAt: 13_500,
        responseDurationMs: 1_500,
        outputTokens: 500,
        tokensPerSecond: 60,
        parts: [{ id: "a2-thinking", type: "thinking", text: "thinking" }, tool("a2-tool", 15_000)],
      },
      // 本文を吹き出しへ出す応答は、そちらのヘッダーが使用量を持つ。
      {
        id: "a3",
        role: "assistant",
        createdAt: 16_500,
        responseDurationMs: 4_000,
        outputTokens: 2_000,
        tokensPerSecond: 90,
        parts: [{ id: "a3-thinking", type: "thinking", text: "summary" }, { id: "a3-text", type: "text", text: "done" }],
      },
    ],
    isStreaming: false,
    isCompacting: false,
  });
  render(<TaskView taskId={task.id} mdUp />);

  const summary = document.querySelector("details[data-task-tool-group] summary");
  // a1..a2 span from generation start (10.0s) to the last tool end (16.0s); a3 is not counted.
  expect(summary?.textContent).toBe("作業ログ4件");
  expect(mocks.messageMetaHeader.mock.calls.find(([props]) => props.usage)?.[0].usage).toEqual({ outputTokens: 1_500, avgRate: 40, elapsedMs: 6_000 });
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
  expect(groups).toHaveLength(1);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("4件");
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
  expect(document.querySelector("details[data-task-tool-group]")).toBeNull();
  expect(mocks.toolCard.mock.calls.some(([props]) => props.part.id === "long-tool")).toBe(true);
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
  expect(groups).toHaveLength(1);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("2件");
  expect(mocks.toolCard.mock.calls.some(([props]) => props.part.id === "tool-3-part")).toBe(true);
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
  expect(groups).toHaveLength(1);
  expect(groups[0]!.querySelector("summary")?.textContent).toContain("2件");
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

  it("keeps manual compaction available regardless of automatic compaction settings", async () => {
    mocks.getJson.mockImplementation((path: string) =>
      path === `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`
        ? Promise.resolve({ value: "auto" })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
    );
    render(<TaskView taskId={task.id} mdUp />);

    expect(await screen.findByRole("button", { name: "コンテキスト圧縮" })).toBeTruthy();
    expect(mocks.getJson.mock.calls.some(([path]) => path === `/api/settings/${COMPACTION_ACTION_SETTING_KEY}`)).toBe(false);
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

  it("clears session hydration after repeated transport SSE failures", async () => {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      constructor() {
        super();
        TestEventSource.instances.push(this);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => {
      expect(screen.getByText(/セッションを準備しています/)).toBeTruthy();
    });
    vi.useFakeTimers();
    try {
      const failAndReconnect = async (index: number, delayMs: number) => {
        const current = TestEventSource.instances[index];
        if (!current) throw new Error(`EventSource ${index} was not created`);
        await act(async () => {
          current.dispatchEvent(new Event("error"));
        });
        await act(async () => {
          vi.advanceTimersByTime(delayMs);
        });
      };
      await failAndReconnect(0, 1_000);
      await failAndReconnect(1, 2_000);
      const third = TestEventSource.instances[2];
      if (!third) throw new Error("Third EventSource was not created");
      await act(async () => {
        third.dispatchEvent(new Event("error"));
      });
      expect(screen.queryByText(/セッションを準備しています/)).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain("イベント接続が切断されています");
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps title generation in the title row and read-aloud after the Bot control", async () => {
    const delegatedTask = { ...task, kind: "code" as const, status: "working" as const, supervisorBotId: "bot-1" };
    saveTaskSessionCache({ task: delegatedTask, messages: [], isStreaming: true, isCompacting: false });
    mocks.botFor.mockImplementation((id) => id === "bot-1" ? { id, name: "監督Bot" } : undefined);
    render(<TaskView taskId={task.id} mdUp />);

    const selector = await screen.findByRole("combobox", { name: "Codeタスクを監督するBot" });
    const botControl = selector.closest("label");
    // The compaction and TTS controls appear only after the settings fetch settles.
    const compact = await screen.findByRole("button", { name: "コンテキスト圧縮" });
    const generateTitle = screen.getByRole("button", { name: "タイトルを生成" });
    const header = screen.getByRole("heading", { name: task.title }).closest("header")!;
    const tts = await screen.findByRole("switch", { name: "読み上げ" });
    expect(generateTitle.parentElement).toBe(header.firstElementChild);
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

  it("shows the average tok/s of all responses beside the label in narrow panes and in the wide status row", () => {
    saveTaskSessionCache({
      task: { ...task, label: "code" },
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          createdAt: 1,
          inputTokens: 3400,
          outputTokens: 1200,
          tokensPerSecond: 20,
          parts: [{ id: "reply-1", type: "text", text: "reply one" }],
        },
        // ツールだけの応答は作業ログ先頭になり、メッセージヘッダーに tok/s が出ないが平均には含める。
        {
          id: "assistant-tool",
          role: "assistant",
          createdAt: 30_001,
          tokensPerSecond: 60,
          parts: [{ id: "tool-1", type: "tool", tool: "read", callID: "call-1", state: { status: "completed", input: {} } }],
        },
        {
          id: "assistant-2",
          role: "assistant",
          createdAt: 60_001,
          tokensPerSecond: 40,
          parts: [{ id: "reply-2", type: "text", text: "reply two" }],
        },
        {
          id: "assistant-3",
          role: "assistant",
          createdAt: 60_001,
          tokensPerSecond: 0,
          parts: [{ id: "reply-3", type: "text", text: "reply three" }],
        },
      ],
      isStreaming: false,
      isCompacting: false,
      contextUsage: { tokens: 405_000, contextWindow: 1_000_000, percent: 41 },
    });
    render(<TaskView taskId={task.id} mdUp={false} />);

    const sessionInfo = screen.getByLabelText("セッション情報");
    const status = screen.getByLabelText("タスクの状態");
    const heading = screen.getByRole("heading", { name: task.title });
    expect(heading.closest("header")?.firstElementChild?.className).toContain("translate-y-1");
    expect(status.firstElementChild?.getAttribute("aria-label")).toBe("プロジェクトアイコン");
    expect(heading.closest("header")?.firstElementChild?.contains(status.firstElementChild)).toBe(false);
    // 表示名は既定ラベルから引く（既定名を変えてもこのレイアウトテストは壊れない）。
    const codeLabel = DEFAULT_SESSION_LABELS.find(({ id }) => id === "code")!.name;
    expect(sessionInfo.textContent).toContain(codeLabel);
    expect(sessionInfo.className).toContain("@min-[500px]/task:hidden");
    expect(heading.className).toContain("@min-[500px]/task:items-center");
    expect(heading.firstElementChild?.textContent).toBe(codeLabel);
    expect(heading.firstElementChild?.className).toContain("@min-[500px]/task:inline-flex");
    expect(heading.firstElementChild?.nextElementSibling?.textContent).toBe(task.title);
    const meterTitle = "コンテキスト使用量: 405k / 1M トークン（41%）";
    const narrowMeter = sessionInfo.querySelector(`[title="${meterTitle}"]`);
    const wideMeter = status.querySelector(`[title="${meterTitle}"]`);
    const [narrowRate, wideRate] = screen.getAllByTitle("平均 tok/s（全応答の tok/s の平均）");
    expect(narrowMeter?.parentElement?.className).toContain("@min-[500px]/task:hidden");
    expect(wideMeter?.parentElement?.className).toContain("hidden @min-[500px]/task:flex");
    expect(sessionInfo.className).toContain("overflow-hidden");
    expect(narrowMeter?.querySelector(".truncate")).toBeTruthy();
    expect(screen.queryByText(/↑3\.4k/)).toBeNull();
    expect(sessionInfo.contains(narrowRate!)).toBe(true);
    // (20 + 60 + 40) / 3。0 tok/s（未計測）は除く。
    expect(narrowRate!.textContent).toBe("40 tok/s");
    expect(status.contains(wideRate!)).toBe(true);
    expect(wideRate!.textContent).toBe("40 tok/s");
    expect(wideRate!.className).toContain("hidden");
    expect(wideRate!.className).toContain("@min-[500px]/task:inline");
    const [narrowTokens, wideTokens] = screen.getAllByTitle("合計出力トークン");
    const [narrowDuration, wideDuration] = screen.getAllByTitle("合計生成時間（メッセージ間隔の累計）");
    expect(narrowTokens!.textContent).toBe("1.2k tok");
    expect(sessionInfo.contains(narrowTokens!)).toBe(true);
    expect(narrowTokens!.compareDocumentPosition(narrowRate!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(narrowRate!.compareDocumentPosition(narrowDuration!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(narrowDuration!.textContent).toBe("1m 0s");
    expect(sessionInfo.contains(narrowDuration!)).toBe(true);
    expect(status.contains(wideTokens!)).toBe(true);
    expect(status.contains(wideDuration!)).toBe(true);
    expect(wideTokens!.compareDocumentPosition(wideRate!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wideTokens!.className).toContain("@min-[500px]/task:inline");
    expect(wideMeter?.className).toContain("@min-[500px]/task:text-[11px]");
  });

  it("edits the full title directly and keeps secondary actions separate", () => {
    const title = "再起動オーバーレイの表示条件とヘッダーレイアウトを改善する";
    saveTaskSessionCache({ task: { ...task, title }, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp={false} />);

    const heading = screen.getByRole("heading", { name: title });
    expect(screen.queryByRole("button", { name: `タイトルを編集: ${title}` })).toBeNull();
    // The unlabelled placeholder badge ("-") is decorative and precedes the title.
    expect(heading.textContent).toBe(`-${title}`);
    expect(screen.getAllByText("クリーン")).toHaveLength(1);
    const header = heading.closest("header")!;
    const placeholderBadges = header.querySelectorAll('[data-placeholder="true"]');
    expect(placeholderBadges).toHaveLength(2);
    for (const badge of placeholderBadges) {
      expect(badge.className).toContain("w-11");
      expect(badge.className).toContain("text-center");
    }
    const actions = screen.getByRole("group", { name: "タスク操作" });
    const botControl = screen.getByRole("combobox", { name: "Codeタスクを監督するBot" }).closest("label");
    const generateButton = screen.getByRole("button", { name: "タイトルを生成" });
    expect(generateButton.parentElement).toBe(header.firstElementChild);
    expect(generateButton.className).not.toContain("hidden");
    expect(generateButton.className).toContain("h-11 w-11");
    expect(heading.parentElement?.contains(generateButton)).toBe(false);
    expect(actions.contains(generateButton)).toBe(false);
    const searchButton = screen.getByRole("button", { name: "セッション内を検索" });
    expect(actions.contains(searchButton)).toBe(false);
    expect(screen.getByRole("group", { name: "メッセージナビゲーター" }).contains(searchButton)).toBe(true);
    expect(searchButton.className).not.toContain("hidden");
    expect(searchButton.className).toContain("h-10 w-10");
    expect(actions.contains(botControl!)).toBe(true);
    fireEvent.click(heading);
    expect(screen.queryByRole("textbox", { name: "セッションタイトル" })).toBeNull();
    fireEvent.doubleClick(heading);
    const input = screen.getByRole("textbox", { name: "セッションタイトル" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("heading", { name: title }), { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "セッションタイトル" })).toBeTruthy();
    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps title generation in the header and search in the navigator regardless of mdUp=%s", (mdUp) => {
    render(<TaskView taskId={task.id} mdUp={mdUp} />);

    const generateButton = screen.getByRole("button", { name: "タイトルを生成" });
    const searchButton = screen.getByRole("button", { name: "セッション内を検索" });
    const header = screen.getByRole("heading", { name: task.title }).closest("header")!;
    const actions = screen.getByRole("group", { name: "タスク操作" });
    expect(generateButton.parentElement).toBe(header.firstElementChild);
    expect(actions.contains(searchButton)).toBe(false);
    expect(screen.getByRole("group", { name: "メッセージナビゲーター" }).contains(searchButton)).toBe(true);
    expect(generateButton.className).not.toContain("hidden");
    expect(generateButton.className).toContain("@min-[500px]/task:h-9");
    expect(generateButton.className).toContain("@min-[500px]/task:w-9");
    expect(searchButton.className).not.toContain("hidden");
    expect(searchButton.className).toContain("h-10 w-10");
    fireEvent.click(searchButton);
    expect(searchButton.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(searchButton);
    expect(searchButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("edits the title and turns automatic updates off", async () => {
    const updatedTask = { ...task, title: "手動タイトル", titleAutoUpdate: false };
    mocks.sendJson.mockResolvedValue({ task: updatedTask });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.doubleClick(screen.getByRole("heading", { name: task.title }));
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
    const wideButton = screen.getByRole("heading", { name: task.title }).closest("header")!
      .firstElementChild?.querySelector('button[aria-label="タイトルを生成"]');
    fireEvent.click(wideButton!);

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
    expect(screen.queryByRole("button", { name: "送信方式" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "queued prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "unfinished draft" } });
    expect(screen.getByRole("button", { name: "即時送信: queued prompt" })).toBeTruthy();
    await snapshot(false);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "queued prompt" }),
    ));
    expect(input.value).toBe("unfinished draft");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBeUndefined();
  });

  it("injects only the selected queued pill and preserves the next draft", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({ eventType: "ready", task: { ...task, status: "working", isStreaming: true }, messages: [] }),
      }));
    });
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    for (const text of ["first", "second"]) {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    }
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "即時送信: second" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "second", streamingBehavior: "steer", interruptIfSafe: true }),
    ));
    expect(input.value).toBe("draft");
    expect(screen.getByRole("button", { name: "即時送信: first" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "即時送信: second" })).toBeNull();
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
  });

  it("restores a failed immediate send to the queue without duplicating the draft", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockRejectedValueOnce(new Error("offline"));
    render(<TaskView taskId={task.id} mdUp />);
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({ eventType: "ready", task: { ...task, status: "working", isStreaming: true }, messages: [] }),
      }));
    });
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "retry this" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    fireEvent.change(input, { target: { value: "new draft" } });
    fireEvent.click(screen.getByRole("button", { name: "即時送信: retry this" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "即時送信: retry this" })).toBeTruthy());
    expect(input.value).toBe("new draft");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("offline");
  });

  it("shows a steer as pending until its row lands at the tool boundary", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({ task: { ...task, status: "working", isStreaming: true } });
    render(<TaskView taskId={task.id} mdUp />);
    const working = (messages: UiMessage[]) => act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({ eventType: "ready", task: { ...task, status: "working", isStreaming: true }, isStreaming: true, messages }),
      }));
    });
    await working([]);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "割り込み指示" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    fireEvent.click(screen.getByRole("button", { name: "即時送信: 割り込み指示" }));
    await waitFor(() => expect(document.querySelector("[data-pending-steer]")?.textContent).toContain("次の区切りで割り込みます"));
    expect(document.querySelector("[data-pending-steer]")?.textContent).toContain("割り込み指示");
    await working([{ id: "steer-row", role: "user", createdAt: Date.now() + 1, parts: [{ id: "t", type: "text", text: "割り込み指示" }] }]);
    await waitFor(() => expect(document.querySelector("[data-pending-steer]")).toBeNull());
  });

  it("posts a double submit of the same draft only once", async () => {
    mocks.sendJson.mockReturnValue(new Promise(() => undefined));
    render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "once" } });
    const form = screen.getByRole("form", { name: "フォローアップ" });
    fireEvent.submit(form);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll("[data-optimistic-prompt]")).toHaveLength(1);
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
    const input = screen.getByRole("textbox", { name: "フォローアップ" });
    fireEvent.change(input, { target: { value: "retry after error" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).not.toHaveBeenCalled();

    await sendSnapshot("error", "current turn failed");
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "retry after error" }),
    ));
  });

  it("sends immediately when idle without showing a delivery selector", async () => {
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    expect(screen.queryByRole("button", { name: "送信方式" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "instruction" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(1));
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBeUndefined();
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

  it.each([false, true])("serializes effort writes and coalesces intermediate choices (failure: %s)", async (failFirst) => {
    const modelTask = { ...task, providerID: "provider", modelID: "a", thinkingLevel: "medium" as const };
    const models: ModelOption[] = [{ value: "provider::a", label: "Model A", providerID: "provider", modelID: "a", thinkingLevels: ["low", "medium", "high"] }];
    writeCachedModels(models);
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    let finishFirst!: () => void;
    let fail!: (error: Error) => void;
    const first = new Promise<void>((resolve, reject) => { finishFirst = resolve; fail = reject; });
    let serverLevel = "medium";
    mocks.sendJson.mockImplementation(async (_url: string, body: { thinkingLevel: string }) => {
      if (body.thinkingLevel === "low") await first;
      serverLevel = body.thinkingLevel;
      return { task: { ...modelTask, thinkingLevel: serverLevel } };
    });
    render(<TaskView taskId={task.id} mdUp />);
    const choose = (level: string) => {
      fireEvent.click(screen.getByRole("button", { name: "思考レベル" }));
      fireEvent.click(screen.getByRole("option", { name: level }));
    };
    choose("low");
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(1));
    choose("medium");
    choose("high");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (failFirst) fail(new Error("first request failed"));
      else finishFirst();
      await first.catch(() => undefined);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "思考レベル" }).textContent).toContain("high"));
    expect(serverLevel).toBe("high");
    expect(mocks.sendJson).toHaveBeenCalledTimes(2);
    expect(mocks.sendJson).not.toHaveBeenCalledWith(expect.anything(), { thinkingLevel: "medium" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["success", "error", "fallback", "task-switch", "model-switch", "unmount"])("ignores an obsolete effort response (%s)", async (outcome) => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const modelTask = { ...task, providerID: "provider", modelID: "a", thinkingLevel: "medium" as const };
    const models: ModelOption[] = [
      { value: "provider::a", label: "Model A", providerID: "provider", modelID: "a", thinkingLevels: ["low", "medium", "high"] },
      { value: "fallback::b", label: "Model B", providerID: "fallback", modelID: "b", thinkingLevels: ["low", "high"] },
    ];
    writeCachedModels(models);
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    let resolveOlder!: (result: { task: TaskSummary }) => void;
    let rejectOlder!: (reason: Error) => void;
    const olderResponse = new Promise<{ task: TaskSummary }>((resolve, reject) => { resolveOlder = resolve; rejectOlder = reject; });
    mocks.sendJson.mockReturnValueOnce(olderResponse).mockResolvedValue({ task: { ...modelTask, thinkingLevel: "high" } });
    const view = render(<TaskView taskId={task.id} mdUp />);
    const choose = (level: string) => {
      fireEvent.click(screen.getByRole("button", { name: "思考レベル" }));
      fireEvent.click(screen.getByRole("option", { name: level }));
    };
    choose("low");
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(1));
    if (["fallback", "task-switch", "model-switch", "unmount"].includes(outcome)) choose("high");
    if (outcome === "fallback") {
      await act(async () => {
        TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({ eventType: "provider_fallback", task: { ...modelTask, providerID: "fallback", modelID: "b", thinkingLevel: "high" }, isStreaming: false }),
        }));
      });
    } else if (outcome === "task-switch") {
      const nextTask = { ...modelTask, id: "next-task", thinkingLevel: "high" as const };
      saveTaskSessionCache({ task: nextTask, messages: [], isStreaming: false, isCompacting: false });
      view.rerender(<TaskView taskId={nextTask.id} mdUp />);
    } else if (outcome === "model-switch") {
      mocks.sendJson.mockResolvedValue({ task: { ...modelTask, providerID: "fallback", modelID: "b", thinkingLevel: "high" } });
      fireEvent.click(screen.getByRole("button", { name: "モデル" }));
      fireEvent.click(screen.getByRole("option", { name: "Model B" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "思考レベル" }).textContent).toContain("high"));
    } else if (outcome === "unmount") {
      view.unmount();
    } else {
      choose("high");
      await act(async () => { await Promise.resolve(); });
      expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    }
    await act(async () => {
      if (outcome === "error") rejectOlder(new Error("obsolete effort failure"));
      else resolveOlder({ task: { ...modelTask, thinkingLevel: "low" } });
      await olderResponse.catch(() => undefined);
    });
    if (outcome !== "unmount") await waitFor(() => expect(screen.getByRole("button", { name: "思考レベル" }).textContent).toContain("high"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(localStorage.getItem("leafcodepi.thinkingLevel")).not.toBe("low");
    if (outcome === "fallback") expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B");
    expect(mocks.sendJson).toHaveBeenCalledTimes(["success", "error", "model-switch"].includes(outcome) ? 2 : 1);
  });

  it("does not repaint stale task status from an effort-only response", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const modelTask = { ...task, sessionId: "session-1", providerID: "provider", modelID: "a", thinkingLevel: "medium" as const };
    const models: ModelOption[] = [{ value: "provider::a", label: "Model A", providerID: "provider", modelID: "a", thinkingLevels: ["low", "medium", "high"] }];
    writeCachedModels(models);
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    let resolve!: (result: { task: TaskSummary }) => void;
    const response = new Promise<{ task: TaskSummary }>((done) => { resolve = done; });
    mocks.sendJson.mockReturnValue(response);
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "思考レベル" }));
    fireEvent.click(screen.getByRole("option", { name: "high" }));
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({ eventType: "agent_start", task: { ...modelTask, status: "working" }, isStreaming: false }),
      }));
    });
    expect(screen.getByRole("button", { name: "進捗を確認" })).toBeTruthy();
    await act(async () => {
      resolve({ task: { ...modelTask, thinkingLevel: "high" } });
      await response;
    });
    expect(screen.getByRole("button", { name: "進捗を確認" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "思考レベル" }).textContent).toContain("high");
  });

  it.each(["snapshot", "response", "late-response"])("uses the fallback model's effort options after a manual model selection (%s)", async (delivery) => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const modelTask = { ...task, providerID: "provider", modelID: "a", thinkingLevel: "medium" as const };
    const models: ModelOption[] = [
      { value: "provider::a", label: "Model A", providerID: "provider", modelID: "a", thinkingLevels: ["low", "medium", "high"] },
      { value: "fallback::b", label: "Model B", providerID: "fallback", modelID: "b", thinkingLevels: ["low", "high"] },
    ];
    writeCachedModels(models);
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    const fallbackTask = { ...modelTask, providerID: "fallback", modelID: "b", thinkingLevel: "low" as const };
    let resolveOlder!: (result: { task: TaskSummary }) => void;
    const olderResponse = new Promise<{ task: TaskSummary }>((resolve) => { resolveOlder = resolve; });
    if (delivery === "late-response") mocks.sendJson.mockReturnValue(olderResponse);
    else mocks.sendJson.mockResolvedValue({ task: delivery === "response" ? fallbackTask : modelTask });
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model A" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(`/api/tasks/${task.id}/model`, { model: "provider::a" }));
    await act(async () => { await Promise.resolve(); });
    if (delivery !== "response") {
      await act(async () => {
        TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({ eventType: "provider_fallback", task: fallbackTask, isStreaming: false, isCompacting: false }),
        }));
      });
    }
    if (delivery === "late-response") {
      await act(async () => { resolveOlder({ task: modelTask }); await olderResponse; });
    }
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B");
    fireEvent.click(screen.getByRole("button", { name: "思考レベル" }));
    expect(screen.queryByRole("option", { name: "medium" })).toBeNull();
    mocks.sendJson.mockResolvedValue({ task: { ...fallbackTask, thinkingLevel: "high" } });
    fireEvent.click(screen.getByRole("option", { name: "high" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "思考レベル" }).textContent).toContain("high"));
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
    await act(async () => { await Promise.resolve(); });
    expect(mocks.getJson).toHaveBeenCalledWith("/api/agents");
    expect(screen.queryByRole("button", { name: "エージェント" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "next" } });
    mocks.sendJson.mockResolvedValue({ task: agentTask });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ agent: "builder" }),
    ));
  });

  it("shows the task agent selector when another agent is enabled", async () => {
    mocks.getJson.mockResolvedValue({
      models: [],
      agents: [
        { name: "default", enabled: true },
        { name: "reviewer", enabled: true },
        { name: "disabled", enabled: false },
      ],
      skills: [],
      accounts: [],
    });
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(await screen.findByRole("button", { name: "エージェント" }));
    expect(Array.from(screen.getByRole("listbox", { name: "エージェント" }).querySelectorAll('[role="option"]')).map((option) => option.textContent)).toEqual(["default", "reviewer"]);
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

  it.each(["pause", "stop"] as const)("keeps %s available while the loop start response is pending", async (action) => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const loop = {
      id: "loop-1", sessionId: "session-1", cwd: "C:/work", status: "queued" as const,
      goal: "goal", acceptance: [], maxTurns: 0, cooldownSeconds: 0, nextTurnAt: null,
      forceFullRun: false, turnCount: 0, turnKind: "goal" as const, pauseReason: "" as const,
      error: "", progress: [], summary: "", evidence: "", blockedReason: "",
      rejectedClaims: 0, unreadableStreak: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    let resolveStart!: (value: unknown) => void;
    mocks.sendJson.mockImplementation((_path: string, body: { action?: string }) => body.action === "start"
      ? new Promise((resolve) => { resolveStart = resolve; })
      : Promise.resolve({ loop: { ...loop, status: action === "pause" ? "paused" : "stopped" } }));
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "goal" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({ eventType: "ready", task: { ...task, status: "working" }, goalLoop: loop, messages: [] }),
      }));
    });
    const control = within(screen.getByRole("region", { name: "Goal loop" })).getByRole("button", { name: action === "pause" ? "一時停止" : "停止" }) as HTMLButtonElement;
    expect(control.disabled).toBe(false);
    fireEvent.click(control);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/goal-loop`, { action }, "PATCH",
    ));
    // Finishing the control must not clear the still-pending start submission.
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "next draft" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).toHaveBeenCalledTimes(2);
    await act(async () => { resolveStart({ loop }); });
  });

  it("does not let a slower start reply revive a loop stopped from the panel", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const loop = {
      id: "loop-1", sessionId: "session-1", cwd: "C:/work", status: "queued" as const,
      goal: "goal", acceptance: [], maxTurns: 0, cooldownSeconds: 0, nextTurnAt: null,
      forceFullRun: false, turnCount: 0, turnKind: "goal" as const, pauseReason: "" as const,
      error: "", progress: [], summary: "", evidence: "", blockedReason: "",
      rejectedClaims: 0, unreadableStreak: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    let resolveStart!: (value: unknown) => void;
    mocks.sendJson.mockImplementation((_path: string, body: { action?: string }) => body.action === "start"
      ? new Promise((resolve) => { resolveStart = resolve; })
      : Promise.resolve({ loop: { ...loop, status: "stopped" } }));
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "goal" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await act(async () => {
      TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({ eventType: "ready", task: { ...task, status: "idle" }, goalLoop: loop, messages: [] }),
      }));
    });
    fireEvent.click(within(screen.getByRole("region", { name: "Goal loop" })).getByRole("button", { name: "停止" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Goal loop" })).toBeNull());
    await act(async () => { resolveStart({ loop }); });
    expect(screen.queryByRole("region", { name: "Goal loop" })).toBeNull();
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

  it.each([false, true])("confirms a delivered prompt after an HTTP failure without restoring it (new draft: %s)", async (newDraft) => {
    let reject!: (error: Error) => void;
    let delivered = false;
    mocks.sendJson.mockReturnValue(new Promise((_, no) => { reject = no; }));
    mocks.getJson.mockImplementation((path: string) => Promise.resolve(path === `/api/tasks/${task.id}`
      ? {
          task: {
            ...task,
            messages: delivered
              ? [{ id: "received", role: "user", createdAt: 2, parts: [{ id: "text", type: "text", text: "received input" }] }]
              : [],
          },
        }
      : { models: [], agents: [], skills: [], accounts: [] }));
    render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "received input" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(input.value).toBe("");
    if (newDraft) fireEvent.change(input, { target: { value: "next draft" } });
    await act(async () => {
      delivered = true;
      reject(Object.assign(new Error("Backendへ転送できません"), { code: "BACKEND_FORWARD_FAILED", reason: "bad-response" }));
    });
    expect(mocks.getJson).toHaveBeenCalledWith(`/api/tasks/${task.id}`, { messages: "page" }, expect.objectContaining({ coalesce: false }));
    expect(screen.queryByText("Backendへ転送できません")).toBeNull();
    expect(screen.queryByText(/送信結果を確認できません/)).toBeNull();
    expect(input.value).toBe(newDraft ? "next draft" : "");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
  });

  it("confirms a timed-out prompt when history updates on a later reconciliation read", async () => {
    let sendFailed = false;
    let historyReads = 0;
    const received: UiMessage = { id: "received", role: "user", createdAt: 2, parts: [{ id: "text", type: "text", text: "retry this" }] };
    mocks.getJson.mockImplementation((path: string) => {
      if (path === `/api/tasks/${task.id}` && sendFailed) {
        historyReads += 1;
        return Promise.resolve({ task: { ...task, messages: historyReads >= 2 ? [received] : [] } });
      }
      return Promise.resolve(path === `/api/tasks/${task.id}`
        ? { task: { ...task, messages: [] } }
        : { models: [], agents: [], skills: [], accounts: [] });
    });
    mocks.sendJson.mockImplementation(async () => {
      sendFailed = true;
      throw Object.assign(new Error("リクエストがタイムアウトしました"), { status: 408, reason: "timeout" });
    });
    mocks.partView.mockImplementation(({ message }: { message: UiMessage }) => (
      <div>{message.parts.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join(" ")}</div>
    ));
    render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "retry this" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));

    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(2));
    // The optimistic echo bridges reconciliation and yields to the reconciled row: never both.
    await waitFor(() => expect(screen.getAllByText("retry this")).toHaveLength(1));
    expect(screen.queryByText(/送信結果を確認できません/)).toBeNull();
    expect(input.value).toBe("");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "old", "different", "wrong-task"])("keeps delivery unconfirmed without matching new history (%s)", async (kind) => {
    const old: UiMessage = { id: "old", role: "user", createdAt: 1, parts: [{ id: "old-text", type: "text", text: "retry this" }] };
    saveTaskSessionCache({ task, messages: [old], isStreaming: false, isCompacting: false });
    let failed = false;
    mocks.getJson.mockImplementation((path: string) => Promise.resolve(path === `/api/tasks/${task.id}`
      ? {
          task: {
            ...task,
            id: failed && kind === "wrong-task" ? "other-task" : task.id,
            status: failed ? "working" : task.status,
            messages: !failed || kind === "old"
              ? [old]
              : kind === "empty"
                ? []
                : [{
                    ...old,
                    id: "new",
                    createdAt: 2,
                    parts: [{ id: "text", type: "text", text: kind === "different" ? "different" : "retry this" }],
                  }],
          },
        }
      : { models: [], agents: [], skills: [], accounts: [] }));
    mocks.sendJson.mockImplementation(async () => {
      failed = true;
      throw Object.assign(new Error("Backendへ転送できません"), { code: "BACKEND_FORWARD_FAILED", reason: "bad-response" });
    });
    render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "retry this" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await screen.findByText("送信結果を確認できません。再送前に履歴を確認してください（bad-response）");
    expect(input.value).toBe("retry this");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
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
    // A rejected send never leaves its optimistic echo behind.
    expect(document.querySelector("[data-optimistic-prompt]")).toBeNull();
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

  it("clears permission UI on Stop and does not revive it from a stale SSE snapshot", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockImplementation(async (url: string) => {
      if (String(url).includes("/abort")) {
        return { task: { ...task, status: "idle", isStreaming: false } };
      }
      return {};
    });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const permission = {
      id: "request-stop-1",
      sessionId: "session-1",
      command: "echo test",
      labels: [],
      message: "許可が必要です",
    };
    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, sessionId: "session-1", status: "working", messages: [], isStreaming: true },
          messages: [],
          permissionRequest: permission,
        }),
      }));
    });
    expect(await screen.findByRole("button", { name: "許可" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(`/api/tasks/${task.id}/abort`, {});
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "許可" })).toBeNull();
    });

    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "remote_poll",
          task: { ...task, sessionId: "session-1", status: "idle", isStreaming: false },
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

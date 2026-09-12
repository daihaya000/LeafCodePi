// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { ModelOption, TaskSummary, UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), apiUrl: (path: string) => path, partView: vi.fn(), toolCard: vi.fn(), messageMetaHeader: vi.fn(), botFor: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({ PartView: mocks.partView, ToolCard: mocks.toolCard, MessageMetaHeader: mocks.messageMetaHeader, WorkingRow: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useBotFor: () => mocks.botFor }));

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
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  clearCachedModels();
});

it.each([undefined, "bot-1"])("passes Bot identity only to the sending side (botId: %s)", async (botId) => {
  const bot = { id: "bot-1", name: "Code Bot" };
  mocks.botFor.mockImplementation((id) => id === bot.id ? bot : undefined);
  const messages: UiMessage[] = [
    { id: "prompt", role: "user", createdAt: 1, parts: [{ id: "prompt-text", type: "text", text: "指示" }] },
    { id: "reply", role: "assistant", createdAt: 2, parts: [{ id: "reply-text", type: "text", text: "応答" }] },
  ];
  saveTaskSessionCache({ task: { ...task, botId }, messages, isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  await waitFor(() => expect(mocks.partView).toHaveBeenCalled());
  const props = mocks.partView.mock.calls.map(([value]) => ({ role: value.message.role, bot: value.bot }));
  expect(props).toEqual(expect.arrayContaining([
    { role: "user", bot: botId ? bot : undefined },
    { role: "assistant", bot: undefined },
  ]));
  expect(props.filter((value) => value.role === "assistant").every((value) => value.bot === undefined)).toBe(true);
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

it("shows one Goal Loop turn divider per turn boundary", () => {
  const turnMessage = (id: string, turn: number, kind: "goal" | "verification"): UiMessage => ({
    id,
    role: "assistant",
    createdAt: turn,
    goalLoopTurn: { goalId: "loop-1", turn, kind },
    parts: [],
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
  // メタ行はグループの中だけに出す。外へ出すとグループ1枚につきヘッダーが縦積みになる。
  expect([...group!.querySelectorAll("[data-task-meta]")].map((node) => node.getAttribute("data-task-meta"))).toEqual([
    "tool-1",
    "tool-2",
  ]);
  expect(document.querySelectorAll("[data-task-meta]")).toHaveLength(2);
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

    fireEvent.click(screen.getByRole("button", { name: "コンテキスト圧縮" }));

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/compact`, {}, "POST", { timeoutMs: 240_000 },
    ));
  });

  it("shows token statistics in the lower status row when the task pane has room", () => {
    saveTaskSessionCache({
      task,
      messages: [{
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        outputTokens: 1200,
        tokensPerSecond: 20,
        parts: [],
      }],
      isStreaming: false,
      isCompacting: false,
    });
    render(<TaskView taskId={task.id} mdUp={false} />);

    expect(screen.getByTitle("合計 1.2k tok（出力のみ）").className).toContain("@min-[36rem]/task:inline");
    expect(screen.getByTitle("平均 tok/s（応答ごとの tok/s の平均）").className).toContain("@min-[36rem]/task:inline");
  });

  it("keeps the full title in its edit target and separates secondary actions", () => {
    const title = "再起動オーバーレイの表示条件とヘッダーレイアウトを改善する";
    saveTaskSessionCache({ task: { ...task, title }, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp={false} />);

    const heading = screen.getByRole("heading", { name: title });
    const edit = screen.getByRole("button", { name: `タイトルを編集: ${title}` });
    expect(heading.contains(edit)).toBe(true);
    expect(edit.textContent).toBe(title);
    expect(screen.getAllByText("クリーン")).toHaveLength(1);
    const generateTitle = screen.getByRole("button", { name: "タイトルを生成" });
    expect(screen.getByRole("group", { name: "タスク操作" }).contains(generateTitle)).toBe(false);
    expect(edit.compareDocumentPosition(generateTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(edit);
    const input = screen.getByRole("textbox", { name: "セッションタイトル" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it("edits the title and turns automatic updates off", async () => {
    const updatedTask = { ...task, title: "手動タイトル", titleAutoUpdate: false };
    mocks.sendJson.mockResolvedValue({ task: updatedTask });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(screen.getByRole("button", { name: /^タイトルを編集:/ }));
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

  it("does not regenerate a title automatically", async () => {
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
    expect(mocks.sendJson).not.toHaveBeenCalled();

    await sendSnapshot("working", 5);
    await sendSnapshot("idle", 5);

    expect(mocks.sendJson).not.toHaveBeenCalled();
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

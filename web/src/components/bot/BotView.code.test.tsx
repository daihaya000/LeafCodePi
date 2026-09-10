// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), markRead: vi.fn(), reportStatus: vi.fn() }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useTaskPanes: () => ({ reportStatus: mocks.reportStatus }) }));
vi.mock("@/lib/bot-unread", () => ({ markRead: mocks.markRead }));
vi.mock("@/lib/client", () => mocks);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("next/image", () => ({ default: () => null }));
import { BotView } from "./BotView";
import { BOT_AVATAR_SHAPES } from "@/lib/bot-avatar";
import { ShellProvider } from "@/components/shell/ShellContext";
let listener: (event: { data: string }) => void;
let deltaListener: (event: { data: string }) => void;
function snapshot(payload: object) { act(() => listener({ data: JSON.stringify(payload) })); }
function delta(payload: object) { act(() => deltaListener({ data: JSON.stringify(payload) })); }
const testBot = {
  id: "one",
  name: "Bot",
  label: "Label",
  soul: "",
  avatarColor: "#0071E3",
  avatarImage: null,
  model: "model-a",
  thinkingLevel: "off" as const,
  permissionMode: null,
  skills: { mode: "inherit" as const, include: [], exclude: [] },
  extraRoots: [],
  enabled: true,
  notificationsEnabled: true,
  codeAutoApprove: true,
  createdAt: "",
  updatedAt: "",
};
beforeEach(() => {
  localStorage.clear();
  mocks.getJson.mockImplementation(async (url: string) => url === "/api/models" ? { models: [] } : url.endsWith("/routines") ? { routines: [] } : { bot: testBot });
  mocks.sendJson.mockResolvedValue({ bot: testBot });
  vi.stubGlobal("EventSource", class {
    addEventListener(name: string, callback: typeof listener) {
      if (name === "delta") deltaListener = callback;
      else listener = callback;
    }
    close() {}
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

it("does not mark hidden tab messages read until activation", async () => {
  const view = render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  snapshot({ messages: [{ id: "message", role: "assistant", createdAt: 123, parts: [{ type: "text", text: "hello" }] }] });
  expect(mocks.markRead).not.toHaveBeenCalled();
  view.rerender(<ShellProvider><BotView id="one" active /></ShellProvider>);
  expect(await screen.findByRole("button", { name: "設定" })).toBeTruthy();
  expect(mocks.markRead).toHaveBeenCalledWith("bot", "one", 123);
});

it("defers routine loading until a hidden Bot tab is activated", async () => {
  const view = render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  expect(mocks.getJson).not.toHaveBeenCalledWith("/api/bots/one");
  expect(mocks.getJson).not.toHaveBeenCalledWith("/api/bots/one/routines");

  view.rerender(<ShellProvider><BotView id="one" active /></ShellProvider>);
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/one"));
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/one/routines"));
});

it("ignores a stale Bot response after switching ids", async () => {
  const botOne = { ...testBot, id: "one", name: "One" };
  const botTwo = { ...testBot, id: "two", name: "Two" };
  type BotResponse = { bot: typeof testBot };
  let resolveOne!: (result: BotResponse) => void;
  let resolveTwo!: (result: BotResponse) => void;
  const oneResponse = new Promise<BotResponse>((resolve) => { resolveOne = resolve; });
  const twoResponse = new Promise<BotResponse>((resolve) => { resolveTwo = resolve; });
  mocks.getJson.mockImplementation((url: string) => {
    if (url === "/api/bots/one") return oneResponse;
    if (url === "/api/bots/two") return twoResponse;
    if (url === "/api/models") return Promise.resolve({ models: [] });
    if (url.endsWith("/routines")) return Promise.resolve({ routines: [] });
    return Promise.resolve({ bot: botOne });
  });
  const view = render(<ShellProvider><BotView id="one" /></ShellProvider>);
  view.rerender(<ShellProvider><BotView id="two" /></ShellProvider>);
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/two"));
  await act(async () => { resolveTwo({ bot: botTwo }); await twoResponse; });
  expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
  await act(async () => { resolveOne({ bot: botOne }); await oneResponse; });
  expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "One" })).toBeNull();
});

it("ignores stale routine data after switching ids", async () => {
  const botOne = { ...testBot, id: "one", name: "One" };
  const botTwo = { ...testBot, id: "two", name: "Two" };
  const failedRoutine = { id: "old", botId: "one", name: "Old routine", prompt: "old", schedule: "0 * * * *", enabled: true, createdAt: "", updatedAt: "", failureCount: 1, lastRunAt: null };
  type RoutineResponse = { routines: typeof failedRoutine[] };
  let resolveOne!: (result: RoutineResponse) => void;
  const oneResponse = new Promise<RoutineResponse>((resolve) => { resolveOne = resolve; });
  mocks.getJson.mockImplementation((url: string) => {
    if (url === "/api/bots/one/routines") return oneResponse;
    if (url === "/api/bots/two/routines") return Promise.resolve({ routines: [] });
    if (url === "/api/models") return Promise.resolve({ models: [] });
    return Promise.resolve({ bot: url.includes("/two") ? botTwo : botOne });
  });
  const view = render(<ShellProvider><BotView id="one" /></ShellProvider>);
  view.rerender(<ShellProvider><BotView id="two" /></ShellProvider>);
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/two/routines"));
  await act(async () => { await Promise.resolve(); });
  await act(async () => { resolveOne({ routines: [failedRoutine] }); await oneResponse; });
  expect(screen.queryByRole("status")).toBeNull();
});

it("ignores a stale SSE snapshot after switching ids", async () => {
  const botOne = { ...testBot, id: "one", name: "One" };
  const botTwo = { ...testBot, id: "two", name: "Two" };
  class TestSource {
    static instances: TestSource[] = [];
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { TestSource.instances.push(this); }
    addEventListener(name: string, callback: (event: { data: string }) => void) { this.listeners.set(name, callback); }
    close() {}
  }
  vi.stubGlobal("EventSource", TestSource);
  mocks.getJson.mockImplementation((url: string) => {
    if (url === "/api/bots/one") return Promise.resolve({ bot: botOne });
    if (url === "/api/bots/two") return Promise.resolve({ bot: botTwo });
    if (url === "/api/models") return Promise.resolve({ models: [] });
    if (url.endsWith("/routines")) return Promise.resolve({ routines: [] });
    return Promise.resolve({ bot: botOne });
  });
  const view = render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await screen.findByRole("heading", { name: "One" });
  const liveSnapshot = TestSource.instances[0]?.listeners.get("snapshot");
  if (!liveSnapshot) throw new Error("Initial SSE snapshot listener was not registered");
  await act(async () => {
    liveSnapshot({ data: JSON.stringify({ messages: [{ id: "old", role: "assistant", createdAt: 1, parts: [{ type: "text", id: "t", text: "old reply" }] }] }) });
  });
  expect(screen.getByText("old reply")).toBeTruthy();
  view.rerender(<ShellProvider><BotView id="two" /></ShellProvider>);
  await screen.findByRole("heading", { name: "Two" });
  expect(screen.queryByText("old reply")).toBeNull();
  const staleSnapshot = TestSource.instances[0]?.listeners.get("snapshot");
  if (!staleSnapshot) throw new Error("Initial SSE snapshot listener was not registered");
  await act(async () => {
    staleSnapshot({ data: JSON.stringify({ messages: [{ id: "old", role: "assistant", createdAt: 1, parts: [{ type: "text", id: "t", text: "old reply" }] }] }) });
  });
  expect(screen.queryByText("old reply")).toBeNull();
});

it("defers model loading until a hidden Bot tab is activated", async () => {
  const view = render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  expect(mocks.getJson).not.toHaveBeenCalledWith("/api/models");

  view.rerender(<ShellProvider><BotView id="one" active /></ShellProvider>);
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/models"));
});

it("reports streaming activity for the Bot tab even when hidden", async () => {
  render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  expect(mocks.reportStatus).toHaveBeenLastCalledWith("/bots/one", "idle");
  snapshot({ isStreaming: true });
  expect(mocks.reportStatus).toHaveBeenLastCalledWith("/bots/one", "working");
  snapshot({ isStreaming: false });
  expect(mocks.reportStatus).toHaveBeenLastCalledWith("/bots/one", "idle");
});

it("renders bot empty-state copy instead of literal Unicode escapes", async () => {
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  expect(await screen.findByText("一対一 ボット")).toBeTruthy();
  expect(screen.getByText("下の入力欄からメッセージを送って会話を始めましょう。")).toBeTruthy();
});

it("applies streaming deltas without waiting for a full snapshot", async () => {
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  snapshot({ messages: [{ id: "user-1", role: "user", createdAt: 1, parts: [{ type: "text", text: "質問" }] }] });
  delta({ message: { id: "reply-1", role: "assistant", createdAt: 2, parts: [{ type: "text", text: "途中" }] }, isStreaming: true });
  expect(screen.getByText("途中")).toBeTruthy();
  delta({ message: { id: "reply-1", role: "assistant", createdAt: 2, parts: [{ type: "text", text: "最終回答" }] }, isStreaming: false });
  expect(screen.getByText("最終回答")).toBeTruthy();
  expect(screen.queryByText("途中")).toBeNull();
});

it("renders Bot tool messages with the shared ToolCard outside the chat bubble", async () => {
  const { container } = render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  snapshot({ messages: [{
    id: "tool-message",
    role: "assistant",
    createdAt: 2,
    parts: [{
      id: "tool-1",
      type: "tool",
      tool: "read",
      callID: "call-1",
      state: { status: "running", input: { path: "README.md" } },
    }],
  }], isStreaming: true });

  const card = await screen.findByRole("button", { name: /読取/ });
  expect(card.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".bot-message-bubble")).toBeNull();
  fireEvent.click(card);
  expect(card.getAttribute("aria-expanded")).toBe("true");

  delta({ message: {
    id: "tool-message",
    role: "assistant",
    createdAt: 2,
    parts: [{
      id: "tool-1",
      type: "tool",
      tool: "read",
      callID: "call-1",
      state: { status: "completed", input: { path: "README.md" }, output: "読み取り結果" },
    }],
  }, isStreaming: false });
  expect(await screen.findByText("読み取り結果")).toBeTruthy();
});

it("pauses Code request polling while the Bot tab is hidden", async () => {
  const view = render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  snapshot({ messages: [{
    id: "bot-1",
    role: "assistant",
    createdAt: 2,
    parts: [{ type: "tool", tool: "code_session", callID: "call-1", state: { status: "completed", output: JSON.stringify({ requestId: "request-1" }) } }],
  }] });
  expect(mocks.getJson).not.toHaveBeenCalledWith("/api/bots/one/code-requests");

  view.rerender(<ShellProvider><BotView id="one" active /></ShellProvider>);
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/one/code-requests"));
});

it("shares Code request polling across multiple cards for one Bot", async () => {
  const requests = [
    { id: "request-1", codeTaskId: null, state: "running" as const, prompt: "first" },
    { id: "request-2", codeTaskId: null, state: "running" as const, prompt: "second" },
  ];
  mocks.getJson.mockImplementation(async (url: string) => {
    if (url.endsWith("/code-requests")) return { requests };
    if (url === "/api/models") return { models: [] };
    if (url.endsWith("/routines")) return { routines: [] };
    return { bot: testBot };
  });
  render(<ShellProvider><BotView id="shared" /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  snapshot({ messages: [
    { id: "bot-1", role: "assistant", createdAt: 1, parts: [{ type: "tool", tool: "code_session", callID: "call-1", state: { status: "completed", output: JSON.stringify({ requestId: "request-1" }) } }] },
    { id: "bot-2", role: "assistant", createdAt: 2, parts: [{ type: "tool", tool: "code_session", callID: "call-2", state: { status: "completed", output: JSON.stringify({ requestId: "request-2" }) } }] },
  ] });
  await waitFor(() => {
    const calls = mocks.getJson.mock.calls.filter(([url]) => url === "/api/bots/shared/code-requests");
    expect(calls).toHaveLength(1);
  });
});

it("refreshes Code requests when stopping during an in-flight poll", async () => {
  vi.useFakeTimers();
  const request = { id: "request-1", codeTaskId: null, state: "running" as const, prompt: "first" };
  const stopped = { ...request, state: "cancelled" as const };
  type PollResult = { requests: Array<typeof request | typeof stopped> };
  let codeRequestCalls = 0;
  let releasePoll!: (result: PollResult) => void;
  const pendingPoll = new Promise<PollResult>((resolve) => { releasePoll = resolve; });
  mocks.getJson.mockImplementation(async (url: string) => {
    if (url.endsWith("/code-requests")) {
      codeRequestCalls += 1;
      if (codeRequestCalls === 1) return { requests: [request] };
      if (codeRequestCalls === 2) return pendingPoll;
      return { requests: [stopped] };
    }
    if (url === "/api/models") return { models: [] };
    if (url.endsWith("/routines")) return { routines: [] };
    return { bot: testBot };
  });
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  snapshot({ messages: [{ id: "bot-1", role: "assistant", createdAt: 1, parts: [{ type: "tool", tool: "code_session", callID: "call-1", state: { status: "completed", output: JSON.stringify({ requestId: "request-1" }) } }] }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(codeRequestCalls).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one/code-requests", { action: "abort", requestId: "request-1" });
  expect(codeRequestCalls).toBe(3);
  // The superseded poll may return its stale running snapshot after the forced refresh.
  releasePoll({ requests: [request] });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("Code中断")).toBeTruthy();
});

it("renders delegated Code requests as ID-linked previews in the Bot conversation", async () => {
  const request = { id: "request-1", codeTaskId: "task-1", state: "running", prompt: "実装を確認", queuedAt: 1 };
  mocks.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/models") return { models: [] };
    if (url.endsWith("/routines")) return { routines: [] };
    if (url.endsWith("/code-requests")) return { requests: [request, { ...request, id: "old-request", codeTaskId: "old-task", prompt: "過去の依頼" }] };
    if (url.endsWith("/tasks/task-1")) return { task: { id: "task-1", status: "working", title: "Code task", todoProgress: { completed: 1, total: 4 }, goalLoopSummary: { status: "running", maxTurns: 10, turnCount: 4 }, messages: [{ role: "assistant", parts: [{ type: "text", text: "変更案" }] }] } };
    return { bot: testBot };
  });
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  snapshot({ messages: [
    { id: "user-1", role: "user", createdAt: 1, parts: [{ type: "text", text: "Codeで実装して" }] },
    { id: "bot-1", role: "assistant", createdAt: 2, parts: [{ type: "tool", tool: "code_session", callID: "call-1", state: { status: "completed", output: JSON.stringify({ requestId: "request-1" }) } }] },
  ] });
  const userBubble = await screen.findByText("Codeで実装して");
  const codeRequest = await screen.findByText("Code依頼");
  expect(userBubble.closest("[class*='bg-bot-user']")).not.toContain(codeRequest);
  expect(codeRequest.closest("[class*='bg-bot-user']")).toBeNull();
  expect(screen.queryByText("過去の依頼")).toBeNull();
  expect(mocks.getJson).not.toHaveBeenCalledWith("/api/tasks/old-task");
  expect(screen.getByRole("link", { name: "実行内容を見る" }).getAttribute("href")).toBe("/task/task-1");
  expect(screen.getByRole("status").textContent).toBe("Code実行中");
  const progress = await screen.findByRole("progressbar", { name: "Codeのループ進捗" });
  expect(progress.getAttribute("aria-valuenow")).toBe("40");
  expect(progress.getAttribute("aria-valuemax")).toBe("100");
  expect(progress.getAttribute("aria-valuetext")).toBe("ループ 4/10ターン（40%）");
  expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/task-1");
  fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
  expect(await screen.findByText("変更案")).toBeTruthy();
  expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/task-1");
});

it("answers a delegated Code question from the Bot conversation", async () => {
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  snapshot({ questionRequest: { id: "code-question", sessionId: "code-session", questions: [{ question: "Which parser?", options: [{ label: "A" }] }] } });
  fireEvent.click(screen.getByRole("radio", { name: "A" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith("/api/tasks/bot%3Aone/question", { requestId: "code-question", answers: [["A"]] }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("shows the exact Code command and does not erase a newer approval on response", async () => {
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  const permission = (id: string) => ({ id, sessionId: "code-session", command: "edit parser.ts", labels: [], message: id });
  snapshot({ permissionRequest: permission("first") });
  expect(screen.getByText("edit parser.ts")).toBeTruthy();
  let finish!: () => void;
  mocks.sendJson.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "許可" }));
  snapshot({ permissionRequest: permission("second") });
  await act(async () => finish());
  expect(screen.getByText("second")).toBeTruthy();
  expect(mocks.sendJson).toHaveBeenCalledWith("/api/tasks/bot%3Aone/permission", { requestId: "first", approved: true });
});

it("renders SOUL.md as Markdown by default and auto-saves after entering edit mode", async () => {
  const configuredBot = { ...testBot, soul: "# 役割\n\n**簡潔に答える**" };
  mocks.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/models") return { models: [{ value: "model-a", label: "Model A", providerID: "openai", modelID: "model-a" }] };
    if (url.endsWith("/routines")) return { routines: [] };
    return { bot: configuredBot };
  });
  mocks.sendJson.mockImplementation(async (_url: string, body?: { name?: string; label?: string; soul?: string }) => ({
    bot: { ...configuredBot, ...body },
  }));

  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "設定" }));
  expect(screen.getByRole("heading", { name: "役割" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "ボットの説明" })).toBeNull();
  expect(screen.getByRole("button", { name: "ボットのモデル" }).closest("details")).toBeNull();
  expect(screen.queryByRole("button", { name: "説明を保存" })).toBeNull();
  expect(screen.queryByRole("button", { name: "プロフィールを保存" })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: "ボットの名前" }), { target: { value: "New Bot" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one", { name: "New Bot", label: "Label" }, "PATCH"));

  fireEvent.click(screen.getByRole("button", { name: "編集" }));
  expect(screen.queryByRole("heading", { name: "役割" })).toBeNull();
  const editor = screen.getByRole("textbox", { name: "ボットの説明" }) as HTMLTextAreaElement;
  expect(editor.value).toBe("# 役割\n\n**簡潔に答える**");
  fireEvent.change(editor, { target: { value: "新しい説明" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one", { soul: "新しい説明" }, "PATCH"));
});

it("resets the Bot conversation after confirmation", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "設定" }));
  snapshot({ messages: [{ id: "old", role: "assistant", createdAt: 123, parts: [{ type: "text", text: "old conversation" }] }] });
  expect(await screen.findByText("old conversation")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "会話をリセット" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one", { resetMessages: true }, "PATCH"));
  await waitFor(() => expect(screen.queryByText("old conversation")).toBeNull());
  expect(confirmSpy).toHaveBeenCalledWith("「Bot」の会話をリセットしますか？\nこの操作は取り消せません。");
  confirmSpy.mockRestore();
});

it("saves an icon selection through PATCH and updates the header and existing messages", async () => {
  mocks.sendJson.mockImplementation(async (_url: string, patch: object) => ({ bot: { ...testBot, ...patch } }));
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "設定" }));
  snapshot({ messages: [{ id: "reply", role: "assistant", createdAt: 123, parts: [{ type: "text", text: "hello" }] }] });
  fireEvent.click(screen.getByRole("button", { name: "ボットのアイコンを変更" }));
  fireEvent.click(screen.getByRole("button", { name: "くも" }));
  await screen.findByText("保存しました");
  expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one", { avatarShape: "cloud", avatarImage: null }, "PATCH");
  fireEvent.keyDown(screen.getByRole("dialog", { name: "ボットのアイコン" }), { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "設定" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("dialog", { name: "設定" })).getByRole("button", { name: "設定を閉じる" }));
  // Sender avatars are intentionally aria-hidden beside the visible sender name.
  const avatars = document.querySelectorAll('svg[aria-label="Botのアバター"]');
  expect(avatars).toHaveLength(2);
  for (const avatar of avatars) expect(avatar.querySelector("path")?.getAttribute("d")).toBe(BOT_AVATAR_SHAPES.find((shape) => shape.id === "cloud")!.path);
});

it("keeps the Bot settings panel visibility after remounting", async () => {
  const first = render(<ShellProvider><BotView id="one" /></ShellProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "設定" }));
  expect(await screen.findByRole("dialog", { name: "設定" })).toBeTruthy();

  first.unmount();
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  expect(await screen.findByRole("dialog", { name: "設定" })).toBeTruthy();

  fireEvent.click(within(screen.getByRole("dialog", { name: "設定" })).getByRole("button", { name: "設定を閉じる" }));
  expect(screen.queryByRole("dialog", { name: "設定" })).toBeNull();

  cleanup();
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  expect(screen.queryByRole("dialog", { name: "設定" })).toBeNull();
});

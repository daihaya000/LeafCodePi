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
function snapshot(payload: object) { act(() => listener({ data: JSON.stringify(payload) })); }
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
  vi.stubGlobal("EventSource", class { addEventListener(_name: string, callback: typeof listener) { listener = callback; } close() {} });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

it("does not mark hidden tab messages read until activation", async () => {
  const view = render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
  snapshot({ messages: [{ id: "message", role: "assistant", createdAt: 123, parts: [{ type: "text", text: "hello" }] }] });
  expect(mocks.markRead).not.toHaveBeenCalled();
  view.rerender(<ShellProvider><BotView id="one" active /></ShellProvider>);
  expect(mocks.markRead).toHaveBeenCalledWith("bot", "one", 123);
});

it("reports streaming activity for the Bot tab even when hidden", async () => {
  render(<ShellProvider><BotView id="one" active={false} /></ShellProvider>);
  await screen.findByRole("button", { name: "設定" });
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

it("renders delegated Code requests as ID-linked previews in the Bot conversation", async () => {
  const request = { id: "request-1", codeTaskId: "task-1", state: "running", prompt: "実装を確認", queuedAt: 1 };
  mocks.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/models") return { models: [] };
    if (url.endsWith("/routines")) return { routines: [] };
    if (url.endsWith("/code-requests")) return { requests: [request] };
    if (url.endsWith("/tasks/task-1")) return { task: { id: "task-1", status: "working", title: "Code task", messages: [{ role: "assistant", parts: [{ type: "text", text: "変更案" }] }] } };
    return { bot: testBot };
  });
  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  snapshot({ messages: [{ id: "user-1", role: "user", createdAt: 1, parts: [{ type: "text", text: "Codeで実装して" }] }] });
  const userBubble = await screen.findByText("Codeで実装して");
  const codeRequest = await screen.findByText("Code依頼");
  expect(userBubble.closest("[class*='bg-bot-user']")).toContain(codeRequest);
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

it("auto-saves bot profile and description and keeps model selection outside detailed settings", async () => {
  mocks.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/models") return { models: [{ value: "model-a", label: "Model A", providerID: "openai", modelID: "model-a" }] };
    if (url.endsWith("/routines")) return { routines: [] };
    return { bot: testBot };
  });
  mocks.sendJson.mockImplementation(async (_url: string, body?: { name?: string; label?: string; soul?: string }) => ({
    bot: { ...testBot, ...body },
  }));

  render(<ShellProvider><BotView id="one" /></ShellProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "設定" }));
  expect(screen.getByRole("button", { name: "ボットのモデル" }).closest("details")).toBeNull();
  expect(screen.queryByRole("button", { name: "説明を保存" })).toBeNull();
  expect(screen.queryByRole("button", { name: "プロフィールを保存" })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: "ボットの名前" }), { target: { value: "New Bot" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one", { name: "New Bot", label: "Label" }, "PATCH"));

  fireEvent.change(screen.getByRole("textbox", { name: "ボットの説明" }), { target: { value: "新しい説明" } });
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/one", { soul: "新しい説明" }, "PATCH"));
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

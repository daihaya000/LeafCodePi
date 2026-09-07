// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("next/image", () => ({ default: () => null }));
import { BotView } from "./BotView";
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
  createdAt: "",
  updatedAt: "",
};
beforeEach(() => {
  mocks.getJson.mockImplementation(async (url: string) => url === "/api/models" ? { models: [] } : url.endsWith("/routines") ? { routines: [] } : { bot: testBot });
  mocks.sendJson.mockResolvedValue({ bot: testBot });
  vi.stubGlobal("EventSource", class { addEventListener(_name: string, callback: typeof listener) { listener = callback; } close() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

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

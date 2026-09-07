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
beforeEach(() => {
  mocks.getJson.mockImplementation(async (url: string) => url === "/api/models" ? { models: [] } : url.endsWith("/routines") ? { routines: [] } : { bot: { id: "one", name: "Bot", soul: "", avatarColor: "#0071E3", skills: { mode: "inherit", include: [], exclude: [] }, extraRoots: [] } });
  mocks.sendJson.mockResolvedValue({ ok: true });
  vi.stubGlobal("EventSource", class { addEventListener(_name: string, callback: typeof listener) { listener = callback; } close() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

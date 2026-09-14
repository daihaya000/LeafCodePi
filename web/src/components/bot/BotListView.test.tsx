// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), push: vi.fn(), notifyBotSidebarChanged: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/lib/events", () => ({ notifyBotSidebarChanged: mocks.notifyBotSidebarChanged }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href?: string; className?: string }) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuHeader: () => null }));

import { BotListView } from "./BotListView";

const bot = (codeSessionCount: number) => ({
  id: "one",
  name: "Bot",
  label: "Label",
  soul: "",
  avatarColor: "#0071E3",
  avatarImage: null,
  model: null,
  thinkingLevel: null,
  permissionMode: null,
  skills: { mode: "inherit" as const, include: [], exclude: [] },
  extraRoots: [],
  enabled: true,
  notificationsEnabled: true,
  codeAutoApprove: true,
  createdAt: "",
  updatedAt: "",
  codeSessionCount,
});

beforeEach(() => {
  mocks.getJson.mockReset();
  mocks.sendJson.mockReset();
  mocks.push.mockReset();
  mocks.notifyBotSidebarChanged.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("refreshes the Code count from a Code SSE event without mounting BotView", async () => {
  const sources: TestSource[] = [];
  class TestSource {
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, callback: (event: { data: string }) => void) { this.listeners.set(name, callback); }
    close() {}
  }
  vi.stubGlobal("EventSource", TestSource);
  mocks.notifyBotSidebarChanged.mockImplementation(() => window.dispatchEvent(new Event("webui:bot-sidebar-changed")));
  let bots = [bot(1)];
  mocks.getJson.mockImplementation((url: string) => url === "/api/bots" ? Promise.resolve({ bots }) : Promise.reject(new Error(`Unexpected request: ${url}`)));

  render(<BotListView />);
  await screen.findByLabelText("Codeセッション1件");
  expect(sources).toHaveLength(1);

  bots = [bot(0)];
  act(() => sources[0]!.listeners.get("snapshot")?.({ data: JSON.stringify({ eventType: "code_session_changed" }) }));
  await waitFor(() => expect(screen.queryByLabelText("Codeセッション1件")).toBeNull());
  expect(mocks.notifyBotSidebarChanged).toHaveBeenCalledTimes(1);
});

it("refreshes the Code count and active Avatar after a sidebar change", async () => {
  let bots = [bot(0)];
  mocks.getJson.mockImplementation((url: string) => {
    if (url !== "/api/bots") return Promise.reject(new Error(`Unexpected request: ${url}`));
    return Promise.resolve({ bots });
  });

  render(<BotListView />);
  const avatar = await screen.findByRole("img", { name: "Botのアバター" });
  expect(screen.queryByLabelText("Codeセッション0件")).toBeNull();
  expect(avatar.classList.contains("bot-avatar-working")).toBe(false);

  bots = [bot(1)];
  act(() => window.dispatchEvent(new Event("webui:bot-sidebar-changed")));
  await waitFor(() => {
    expect(screen.getByLabelText("Codeセッション1件")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Botのアバター" }).classList.contains("bot-avatar-working")).toBe(true);
  });
  expect(mocks.getJson).toHaveBeenCalledTimes(2);

  bots = [bot(0)];
  act(() => window.dispatchEvent(new Event("webui:bot-sidebar-changed")));
  await waitFor(() => {
    expect(screen.queryByLabelText("Codeセッション1件")).toBeNull();
    expect(screen.getByRole("img", { name: "Botのアバター" }).classList.contains("bot-avatar-working")).toBe(false);
  });
});

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { applyRoomSnapshot, RoomView } from "./RoomView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("keeps room state identity for an SSE snapshot without visible changes", () => {
  const current: RoomDto = {
    id: "room", name: "Room", members: ["bot"], botRelayEnabled: false,
    createdAt: "", updatedAt: "first",
    messages: [{ id: "message", role: "assistant", text: "same", createdAt: 1, status: "done" }],
  };
  const next: RoomDto = {
    ...current,
    updatedAt: "later",
    members: [...current.members],
    messages: current.messages.map((message) => ({ ...message })),
  };

  expect(applyRoomSnapshot(current, next)).toBe(current);
  expect(applyRoomSnapshot(current, { ...next, messages: [{ ...next.messages[0]!, text: "changed" }] })).not.toBe(current);
});

it("shows each parallel Code request its own live tool label instead of one shared line", async () => {
  const bot = { id: "bot", name: "Bot", enabled: true };
  const room: RoomDto = {
    id: "room", name: "Room", members: [bot.id], botRelayEnabled: false, createdAt: "", updatedAt: "",
    messages: [
      { id: "user", role: "user", text: "two jobs", createdAt: 1 },
      {
        id: "response", role: "assistant", botId: bot.id, text: "二件依頼しました", status: "done", createdAt: 2,
        codeRequests: [
          { id: "first", taskId: "code-1", state: "running", prompt: "First job", activity: "検索" },
          { id: "second", taskId: "code-2", state: "running", prompt: "Second job", activity: "編集" },
        ],
      },
    ],
  };
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
  mocks.getJson.mockImplementation(async (path: string) => {
    if (path === "/api/bots") return { bots: [bot] };
    return { room };
  });

  render(<RoomView id="room" />);

  // Activity is mirrored onto each codeRequests entry (no per-card detail poll while folded).
  expect(await screen.findByText("· 検索")).toBeTruthy();
  expect(await screen.findByText("· 編集")).toBeTruthy();
});

it("renders every request in one Room turn, stops them separately, and stays busy until all settle", async () => {
  const bot = { id: "bot", name: "Bot", enabled: true };
  const room: RoomDto = {
    id: "room", name: "Room", members: [bot.id], botRelayEnabled: false, createdAt: "", updatedAt: "",
    messages: [{ id: "user", role: "user", text: "two jobs", createdAt: 1 }, {
      id: "response", role: "assistant", botId: bot.id, text: "依頼しました", status: "done", createdAt: 2,
      conversation: { requestId: "user", participantIds: [bot.id], turn: 1, maxTurns: 4 },
      codeRequests: [
        { id: "first", taskId: "code-1", state: "running", prompt: "First job" },
        { id: "second", taskId: "code-2", state: "running", prompt: "Second job" },
      ],
    }],
    lastOutcome: { kind: "code-wait", requestId: "user" },
  };
  let snapshot: ((event: MessageEvent) => void) | undefined;
  vi.stubGlobal("EventSource", class {
    addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "snapshot") snapshot = listener; }
    close() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  mocks.getJson.mockImplementation(async (path: string) => path === "/api/bots" ? { bots: [bot] } : path.startsWith("/api/tasks/") ? { task: null } : { room });
  const releases: (() => void)[] = [];
  mocks.sendJson.mockImplementation(() => new Promise<void>((resolve) => { releases.push(resolve); }));
  render(<RoomView id="room" />);
  await screen.findByText("First job");
  expect(screen.getByText("Second job")).toBeTruthy();
  expect(screen.getAllByText("Code実行中")).toHaveLength(2);
  expect(screen.queryByText("Code待機中")).toBeNull();
  expect(screen.getAllByRole("link", { name: "実行内容を見る" }).map((link) => link.getAttribute("href"))).toEqual(["/task/code-1", "/task/code-2"]);
  const buttons = screen.getAllByRole<HTMLButtonElement>("button", { name: "停止" });
  fireEvent.click(buttons[0]);
  expect(buttons[0].disabled).toBe(true);
  expect(buttons[1].disabled).toBe(false);
  fireEvent.click(buttons[1]);
  expect(mocks.sendJson.mock.calls.map((call) => call[1])).toEqual([
    { action: "abort", requestId: "first" }, { action: "abort", requestId: "second" },
  ]);
  await act(async () => { releases.forEach((release) => release()); });

  const update = (state: "running" | "delivered") => {
    const messages = [...room.messages];
    messages[1] = { ...messages[1], codeState: "delivered", codeRequests: [
      { ...messages[1].codeRequests![0], state },
      { ...messages[1].codeRequests![1], state: "delivered" },
    ] };
    snapshot?.({ data: JSON.stringify({ room: { ...room, messages } }) } as MessageEvent);
  };
  act(() => update("running"));
  expect(screen.getByText("応答中…")).toBeTruthy();
  expect(screen.queryByText("会話は完了しました")).toBeNull();
  act(() => update("delivered"));
  expect(screen.queryByText("応答中…")).toBeNull();
  expect(screen.getByText("会話は完了しました")).toBeTruthy();
});

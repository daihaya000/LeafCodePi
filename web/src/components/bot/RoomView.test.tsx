// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  push: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock("@/lib/bot-unread", () => ({ markRead: mocks.markRead }));
vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

import { RoomView } from "./RoomView";

type EventSourceStub = { last?: { listeners: Map<string, (event: MessageEvent) => void> } };
function pushSnapshot(payload: unknown) {
  const source = (globalThis.EventSource as unknown as EventSourceStub).last;
  source?.listeners.get("snapshot")?.({ data: JSON.stringify(payload) } as MessageEvent);
}

const bot = { id: "bot-1", name: "Alpha", avatarColor: "#0071E3", enabled: true };
const room = {
  id: "room-1",
  name: "Team",
  members: [bot.id],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [{ id: "message-1", role: "user" as const, text: "@here hello", createdAt: 1 }],
};

beforeEach(() => {
  mocks.getJson.mockImplementation((path: string) => path === "/api/bots" ? Promise.resolve({ bots: [bot] }) : Promise.resolve({ room }));
  mocks.sendJson.mockResolvedValue({ room });
  class Stub {
    static last: Stub | undefined;
    listeners = new Map<string, (event: MessageEvent) => void>();
    constructor() { Stub.last = this; }
    addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
    close() {}
  }
  vi.stubGlobal("EventSource", Stub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.getJson.mockReset();
  mocks.sendJson.mockReset();
  mocks.push.mockReset();
  mocks.markRead.mockReset();
});

describe("RoomView mention chips", () => {
  it("turns an addressed participant into an avatar chip in both bot Markdown and user text", async () => {
    const { act } = await import("@testing-library/react");
    const { container } = render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({
      room: { ...room, messages: [
        { id: "user-2", role: "user", text: "@Alpha お願い", createdAt: 2 },
        { id: "reply-2", role: "assistant", botId: bot.id, text: "1. 指揮は @Alpha に任せる。", status: "done", createdAt: 3 },
      ] },
    }));

    const chips = container.querySelectorAll("[data-mention]");
    expect([...chips].map((chip) => chip.textContent)).toEqual(["Alpha", "Alpha"]);
    expect([...chips].every((chip) => chip.getAttribute("data-mention") === bot.id)).toBe(true);
    const inList = container.querySelector("li [data-mention]")!;
    expect(inList.textContent).toBe("Alpha");
    expect(inList.querySelector("[aria-label='Alphaのアバター']")).toBeTruthy();
    expect(container.querySelector("li")?.textContent).toBe("指揮は Alpha に任せる。");
  });

  it("leaves an unknown handle as plain text", async () => {
    const { act } = await import("@testing-library/react");
    const { container } = render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({ room: { ...room, messages: [{ id: "reply-3", role: "assistant", botId: bot.id, text: "@Unknown へ連絡", status: "done", createdAt: 4 }] } }));
    expect(container.querySelector("[data-mention]")).toBeNull();
    expect(container.textContent).toContain("@Unknown へ連絡");
  });
});

describe("RoomView delegated work", () => {
  it("shows what Code is doing and lets the user stop that run", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({
      room: { ...room, messages: [{ id: "reply-9", role: "assistant", botId: bot.id, text: "依頼しました", status: "done", createdAt: 2, codeRequestId: "request", codeTaskId: "code-1", codeState: "running", codeActivity: "読取 README.md" }] },
    }));

    expect(screen.getByText("· 読取 README.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${room.id}/code`, { action: "abort" });
  });

  it("tells the user why a quiet room stopped, and only for the latest request", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    const messages = [{ id: "user-2", role: "user" as const, text: "残作業も進めて", createdAt: 2 }];
    act(() => pushSnapshot({ room: { ...room, messages, lastOutcome: { kind: "code-wait", requestId: "user-2" } } }));
    expect(screen.getByText("Codeの結果を待っています")).toBeTruthy();

    // A newer request supersedes the note.
    act(() => pushSnapshot({ room: { ...room, messages: [...messages, { id: "user-3", role: "user" as const, text: "別の依頼", createdAt: 3 }], lastOutcome: { kind: "code-wait", requestId: "user-2" } } }));
    expect(screen.queryByText("Codeの結果を待っています")).toBeNull();
  });

  it("shows Code progress and lets the user answer a member's approval from the room", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    const permission = { id: "permission-1", command: "code_session", message: "Codeへ依頼します", labels: [] };
    act(() => pushSnapshot({
      room: { ...room, messages: [...room.messages, { id: "reply-1", role: "assistant", botId: bot.id, text: "修正を依頼しました", status: "done", createdAt: 2, codeRequestId: "request", codeTaskId: "code-1", codeState: "running" }] },
      attention: [{ botId: bot.id, taskId: `bot:${bot.id}:room:${room.id}`, permission, question: null }],
    }));

    expect(screen.getByText("Code実行中")).toBeTruthy();
    // A running delegated job keeps the room busy indicator on and names who is working.
    expect(screen.getByText("応答中…")).toBeTruthy();
    expect(screen.getByText("Alpha が確認待ち")).toBeTruthy();
    expect(screen.getAllByLabelText("Alphaのアバター").some((node) => node.classList.contains("bot-avatar-working"))).toBe(true);
    expect(screen.getByRole("link", { name: "実行内容を見る" }).getAttribute("href")).toBe("/task/code-1");
    expect(screen.getByRole("alertdialog", { name: "Alphaの権限確認" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "許可" }));
    expect(mocks.sendJson).toHaveBeenCalledWith(`/api/tasks/${encodeURIComponent(`bot:${bot.id}:room:${room.id}`)}/permission`, { requestId: permission.id, approved: true });
  });
});

describe("RoomView mentions", () => {
  it("preserves drafts and marks read only on activation", async () => {
    const view = render(<RoomView id={room.id} active={false} />);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft" } });
    expect(mocks.markRead).not.toHaveBeenCalled();
    view.rerender(<RoomView id={room.id} active />);
    expect(input.value).toBe("draft");
    expect(mocks.markRead).toHaveBeenCalledWith("room", room.id, 1);
  });
  it("shows mention candidates, inserts a selection, and highlights mentions", async () => {
    render(<RoomView id={room.id} />);

    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    expect(screen.getByText("@here").className).toContain("text-accent");

    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } });
    expect(screen.getByRole("listbox", { name: "メンション先候補" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /@Alpha/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /@channel/ }));

    expect(input.value).toBe("@channel ");
  });
});

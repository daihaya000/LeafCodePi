// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("RoomView loading", () => {
  it("ignores a stale room response after switching ids", async () => {
    const roomOne = { ...room, id: "room-1", name: "One" };
    const roomTwo = { ...room, id: "room-2", name: "Two" };
    type RoomResponse = { room: typeof room };
    let resolveOne!: (result: RoomResponse) => void;
    let resolveTwo!: (result: RoomResponse) => void;
    const firstResponse = new Promise<RoomResponse>((resolve) => { resolveOne = resolve; });
    const secondResponse = new Promise<RoomResponse>((resolve) => { resolveTwo = resolve; });
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/rooms/room-1") return firstResponse;
      if (path === "/api/bots/rooms/room-2") return secondResponse;
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      return Promise.resolve({ room });
    });
    const view = render(<RoomView id="room-1" />);
    view.rerender(<RoomView id="room-2" />);
    await vi.waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/rooms/room-2"));
    await act(async () => { resolveTwo({ room: roomTwo }); await secondResponse; });
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    await act(async () => { resolveOne({ room: roomOne }); await firstResponse; });
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "One" })).toBeNull();
  });

  it("ignores a stale SSE snapshot after switching ids", async () => {
    const roomOne = { ...room, id: "room-1", name: "One" };
    const roomTwo = { ...room, id: "room-2", name: "Two" };
    class TestSource {
      static instances: TestSource[] = [];
      listeners = new Map<string, (event: MessageEvent) => void>();
      constructor() { TestSource.instances.push(this); }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
      close() {}
    }
    vi.stubGlobal("EventSource", TestSource);
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/rooms/room-1") return Promise.resolve({ room: roomOne });
      if (path === "/api/bots/rooms/room-2") return Promise.resolve({ room: roomTwo });
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      return Promise.resolve({ room });
    });
    const view = render(<RoomView id="room-1" />);
    await screen.findByRole("heading", { name: "One" });
    view.rerender(<RoomView id="room-2" />);
    await screen.findByRole("heading", { name: "Two" });
    const staleSnapshot = TestSource.instances[0]?.listeners.get("snapshot");
    if (!staleSnapshot) throw new Error("Initial SSE snapshot listener was not registered");
    await act(async () => {
      staleSnapshot({ data: JSON.stringify({ room: roomOne, attention: [] }) } as MessageEvent);
    });
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "One" })).toBeNull();
  });
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

  it("renders mentions followed directly by Japanese particles without matching longer handles", async () => {
    const designer = { ...bot, name: "デザイナー" };
    mocks.getJson.mockImplementation((path: string) => path === "/api/bots" ? Promise.resolve({ bots: [designer] }) : Promise.resolve({ room }));
    const { act } = await import("@testing-library/react");
    const { container } = render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({ room: { ...room, messages: [
      { id: "u", role: "user", text: "@デザイナーに確認", createdAt: 2 },
      { id: "a", role: "assistant", botId: bot.id, text: "@デザイナーの認識で合っています。 **@デザイナーと相談** @デザイナー補佐 @デザイナー2", status: "done", createdAt: 3 },
    ] } }));
    expect([...container.querySelectorAll("[data-mention]")].map((chip) => chip.textContent)).toEqual(["デザイナー", "デザイナー", "デザイナー"]);
    expect(container.textContent).toContain("@デザイナー補佐 @デザイナー2");
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
  it("loads enabled skills into slash suggestions", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      if (path === "/api/skills") return Promise.resolve({ skills: [
        { id: "skill-review", name: "review", description: "変更を確認", enabled: true },
        { id: "skill-off", name: "off", enabled: false },
      ] });
      return Promise.resolve({ room });
    });
    render(<RoomView id={room.id} />);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/skill:r", selectionStart: 8 } });
    expect(await screen.findByRole("option", { name: /review/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /off/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /review/ }));
    expect(input.value).toBe("/skill:review ");
  });

  it("loads Code task progress before opening its preview", async () => {
    const task = {
      id: "code-1",
      kind: "code",
      projectId: null,
      projectName: "LeafCodePi",
      title: "READMEを確認",
      directory: "/tmp/project",
      isolation: "current_folder",
      status: "ready",
      sessionId: "session-1",
      sessionFile: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "**READMEの確認結果**" }] }],
      isStreaming: false,
    };
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      if (path === "/api/tasks/code-1") return Promise.resolve({ task });
      return Promise.resolve({ room });
    });
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({ room: { ...room, messages: [{ id: "reply-code", role: "assistant", botId: bot.id, text: "", status: "done", createdAt: 2, codeTaskId: "code-1", codeState: "delivered" }] } }));

    await vi.waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/code-1"));
    fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
    expect((await screen.findByText("READMEの確認結果")).tagName).toBe("STRONG");
    expect(screen.getByText("完了")).toBeTruthy();
    expect(screen.queryByText("待機中")).toBeNull();
    expect(screen.getByLabelText("Codeの出力").tabIndex).toBe(0);
    expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/code-1");
  });

  it("rewinds the room to a user request and puts its text back in the composer", async () => {
    const { act } = await import("@testing-library/react");
    mocks.sendJson.mockResolvedValueOnce({ room: { ...room, messages: [] }, text: "やり直したい依頼" });
    render(<RoomView id={room.id} />);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    act(() => pushSnapshot({ room: { ...room, messages: [{ id: "user-9", role: "user" as const, text: "やり直したい依頼", createdAt: 2 }] } }));

    fireEvent.click(screen.getByRole("button", { name: /入力欄に戻す/ }));
    expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${room.id}/revert`, { messageId: "user-9" });
    await screen.findByDisplayValue("やり直したい依頼");
    expect(input.value).toBe("やり直したい依頼");
  });

  it("saves standing Code approval without Web UI token auth", async () => {
    mocks.sendJson.mockResolvedValueOnce({ room: { ...room, codeAutoApprove: true } });
    render(<RoomView id={room.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "設定" }));
    const toggle = await screen.findByRole("checkbox", { name: /Codeを毎回承認せずに実行/ });
    fireEvent.click(toggle);
    expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${room.id}`, { codeAutoApprove: true }, "PATCH");
    await vi.waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows attachments of a request and sends them with the prompt", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    act(() => pushSnapshot({ room: { ...room, messages: [{ id: "user-1", role: "user" as const, text: "これ見て", createdAt: 2, images: [{ file: "user-1-0.png", mimeType: "image/png" }] }] } }));
    expect(screen.getByAltText("添付画像").getAttribute("src")).toBe(`/api/bots/rooms/${room.id}/images/user-1-0.png`);

    fireEvent.change(input, { target: { value: "これを見て" } });
    fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["x"], "shot.png", { type: "image/png" }) }] } });
    await screen.findByLabelText("1番目の画像を削除");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${room.id}/prompt`, expect.objectContaining({
      prompt: "これを見て",
      images: [expect.objectContaining({ mimeType: "image/png" })],
    })));
  });

  it("shows what Code is doing and lets the user stop that run", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({
      room: { ...room, messages: [{ id: "reply-9", role: "assistant", botId: bot.id, text: "依頼しました", status: "done", createdAt: 2, codeRequestId: "request", codeTaskId: "code-1", codeState: "running", codeActivity: "読取 README.md" }] },
    }));

    expect(screen.getByText("· 読取 README.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${room.id}/code`, { action: "abort", requestId: "request" });
  });

  it("tells the user why a quiet room stopped, and only for the latest request", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    const messages = [{ id: "user-2", role: "user" as const, text: "残作業も進めて", createdAt: 2 }];
    act(() => pushSnapshot({ room: { ...room, messages, lastOutcome: { kind: "code-wait", requestId: "user-2" } } }));
    expect(screen.getByText("Codeの結果を待っています")).toBeTruthy();

    act(() => pushSnapshot({ room: { ...room, messages: [...messages, {
      id: "report", role: "assistant", text: "結果です", status: "done", createdAt: 3,
      codeState: "delivered", conversation: { requestId: "user-2" },
    }], lastOutcome: { kind: "code-wait", requestId: "user-2" } } }));
    expect(screen.queryByText("Codeの結果を待っています")).toBeNull();
    expect(screen.getByText("会話は完了しました")).toBeTruthy();

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

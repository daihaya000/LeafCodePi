// @vitest-environment happy-dom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  members: [bot.id], botRelayEnabled: false,
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

  it("ignores a late prompt failure after switching ids", async () => {
    const roomOne = { ...room, id: "room-1", name: "One" };
    const roomTwo = { ...room, id: "room-2", name: "Two" };
    let rejectPrompt!: (reason: Error) => void;
    const promptRequest = new Promise<never>((_, reject) => { rejectPrompt = reject; });
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/rooms/room-1") return Promise.resolve({ room: roomOne });
      if (path === "/api/bots/rooms/room-2") return Promise.resolve({ room: roomTwo });
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      return Promise.resolve({ room: roomOne });
    });
    mocks.sendJson.mockImplementation((path: string) => path.endsWith("/prompt") ? promptRequest : Promise.resolve({ room: roomTwo }));
    const view = render(<RoomView id="room-1" />);
    const input = await screen.findByRole("textbox", { name: /Oneにメッセージ/ });
    fireEvent.change(input, { target: { value: "old prompt" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      "/api/bots/rooms/room-1/prompt",
      expect.objectContaining({ prompt: "old prompt", broadcast: false }),
    ));

    view.rerender(<RoomView id="room-2" />);
    await screen.findByRole("heading", { name: "Two" });
    await act(async () => {
      rejectPrompt(new Error("old failure"));
      await promptRequest.catch(() => undefined);
    });

    expect(screen.queryByDisplayValue("old prompt")).toBeNull();
    expect(screen.queryByText("old failure")).toBeNull();
  });

  it("ignores a stale revert result after switching ids", async () => {
    const roomOne = { ...room, id: "room-1", name: "One" };
    const roomTwo = { ...room, id: "room-2", name: "Two" };
    let resolveRevert!: (result: { room: typeof room; text: string; images: never[] }) => void;
    const revertRequest = new Promise<{ room: typeof room; text: string; images: never[] }>((resolve) => { resolveRevert = resolve; });
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/rooms/room-1") return Promise.resolve({ room: roomOne });
      if (path === "/api/bots/rooms/room-2") return Promise.resolve({ room: roomTwo });
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      return Promise.resolve({ room: roomOne });
    });
    mocks.sendJson.mockImplementation((path: string) => path.endsWith("/revert") ? revertRequest : Promise.resolve({ room: roomOne }));
    const view = render(<RoomView id="room-1" />);
    await screen.findByRole("heading", { name: "One" });
    fireEvent.click(screen.getByRole("button", { name: /入力欄に戻す/ }));
    await vi.waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      "/api/bots/rooms/room-1/revert",
      { messageId: "message-1" },
    ));

    view.rerender(<RoomView id="room-2" />);
    await screen.findByRole("heading", { name: "Two" });
    await act(async () => {
      resolveRevert({ room: roomOne, text: "old prompt", images: [] });
      await revertRequest;
    });

    expect(screen.queryByDisplayValue("old prompt")).toBeNull();
  });

  it("ignores a stale SSE snapshot after switching ids", async () => {
    const roomOne = {
      ...room,
      id: "room-1",
      name: "One",
      messages: [{ id: "old", role: "assistant" as const, text: "old room reply", createdAt: 1, status: "done" as const }],
    };
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
    expect(screen.getByText("old room reply")).toBeTruthy();
    view.rerender(<RoomView id="room-2" />);
    await screen.findByRole("heading", { name: "Two" });
    expect(screen.queryByText("old room reply")).toBeNull();
    const staleSnapshot = TestSource.instances[0]?.listeners.get("snapshot");
    if (!staleSnapshot) throw new Error("Initial SSE snapshot listener was not registered");
    await act(async () => {
      staleSnapshot({ data: JSON.stringify({ room: roomOne, attention: [] }) } as MessageEvent);
    });
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "One" })).toBeNull();
    expect(screen.queryByText("old room reply")).toBeNull();
  });

  it("does not let an initial HTTP response overwrite a newer SSE room snapshot", async () => {
    const staleRoom = { ...room, name: "Stale" };
    const liveRoom = { ...room, name: "Live" };
    let resolveRoom!: (result: { room: typeof room }) => void;
    const roomRequest = new Promise<{ room: typeof room }>((resolve) => { resolveRoom = resolve; });
    class TestSource {
      static last: TestSource | undefined;
      listeners = new Map<string, (event: MessageEvent) => void>();
      constructor() { TestSource.last = this; }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
      close() {}
    }
    vi.stubGlobal("EventSource", TestSource);
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/rooms/room-1") return roomRequest;
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      return Promise.resolve({ room });
    });
    render(<RoomView id="room-1" />);
    await vi.waitFor(() => expect(TestSource.last).toBeTruthy());
    const snapshot = TestSource.last?.listeners.get("snapshot");
    if (!snapshot) throw new Error("Room SSE snapshot listener was not registered");
    await act(async () => {
      snapshot({ data: JSON.stringify({ room: liveRoom, attention: [] }) } as MessageEvent);
    });
    expect(screen.getByRole("heading", { name: "Live" })).toBeTruthy();
    await act(async () => {
      resolveRoom({ room: staleRoom });
      await roomRequest;
    });
    expect(screen.getByRole("heading", { name: "Live" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Stale" })).toBeNull();
  });
});

it("reports an SSE transport error while retrying the connection", async () => {
  class TestSource {
    static last: TestSource | undefined;
    onerror: (() => void) | null = null;
    constructor() { TestSource.last = this; }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("EventSource", TestSource);
  render(<RoomView id="room-1" />);
  await screen.findByRole("heading", { name: "Team" });
  act(() => TestSource.last?.onerror?.());
  expect(screen.getByRole("alert").textContent).toContain("イベント接続を再試行しています");
});

it("ignores callbacks from an SSE source replaced after a transport error", async () => {
  vi.useFakeTimers();
  try {
    class TestSource {
      static instances: TestSource[] = [];
      readonly listeners = new Map<string, (event: MessageEvent) => void>();
      onerror: (() => void) | null = null;
      closed = false;
      constructor() { TestSource.instances.push(this); }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
      close() { this.closed = true; }
    }
    vi.stubGlobal("EventSource", TestSource);
    render(<RoomView id="room-1" />);

    const first = TestSource.instances[0];
    if (!first) throw new Error("Initial EventSource was not created");
    act(() => first.onerror?.());
    await act(async () => { vi.advanceTimersByTime(1_000); });

    const second = TestSource.instances[1];
    if (!second) throw new Error("Reconnect EventSource was not created");
    expect(second.closed).toBe(false);
    act(() => first.onerror?.());
    expect(second.closed).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

describe("RoomView opener reason chips", () => {
  it("shows a short chip for keyword and LLM opener reasons", async () => {
    const { act } = await import("@testing-library/react");
    const { container } = render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({
      room: { ...room, messages: [
        { id: "user-kw", role: "user", text: "バグを見つけて", createdAt: 2 },
        { id: "reply-kw", role: "assistant", botId: bot.id, botName: bot.name, text: "再現を見ます", status: "done", createdAt: 3, openerReason: "keyword" },
        { id: "user-llm", role: "user", text: "残作業も進めて", createdAt: 4 },
        { id: "reply-llm", role: "assistant", botId: bot.id, botName: bot.name, text: "進めます", status: "done", createdAt: 5, openerReason: "llm" },
      ] },
    }));
    const chips = [...container.querySelectorAll("[data-opener-reason]")];
    expect(chips.map((chip) => [chip.getAttribute("data-opener-reason"), chip.textContent])).toEqual([
      ["keyword", "キーワード一致"],
      ["llm", "LLM選択"],
    ]);
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
        { id: "skill-review", name: "review", description: "変更を確認", enabled: false, codeEnabled: false, botEnabled: true },
        { id: "skill-off", name: "off", enabled: true, codeEnabled: true, botEnabled: false },
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

  it("loads completed Code task progress only after opening its preview", async () => {
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

    expect(mocks.getJson).not.toHaveBeenCalledWith("/api/tasks/code-1");
    fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
    await vi.waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/code-1"));
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

  it("clears attention after reverting a room message", async () => {
    const { act, waitFor } = await import("@testing-library/react");
    mocks.sendJson.mockResolvedValueOnce({ room: { ...room, messages: [] }, text: "やり直したい依頼" });
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    const permission = { id: "permission-1", command: "code_session", message: "Codeへ依頼します", labels: [] };
    act(() => pushSnapshot({
      room: { ...room, messages: [{ id: "user-9", role: "user" as const, text: "やり直したい依頼", createdAt: 2 }] },
      attention: [{ botId: bot.id, taskId: `bot:${bot.id}:room:${room.id}`, permission, question: null }],
    }));
    expect(screen.getByRole("alertdialog", { name: "Alphaの権限確認" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /入力欄に戻す/ }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "Alphaの権限確認" })).toBeNull();
    });
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

  it("sends with Ctrl+Enter and leaves Enter available for newlines", async () => {
    render(<RoomView id={room.id} />);
    const input = await screen.findByRole("textbox", { name: /Ctrl\+Enterで送信/ }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "依頼" } });

    const enter = createEvent.keyDown(input, { key: "Enter" });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(mocks.sendJson).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/bots/rooms/${room.id}/prompt`,
      expect.objectContaining({ prompt: "依頼", broadcast: false }),
    ));
  });

  it("shows what Code is doing and lets the user stop that run", async () => {
    const { act } = await import("@testing-library/react");
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    act(() => pushSnapshot({
      room: { ...room, messages: [{ id: "reply-9", role: "assistant", botId: bot.id, text: "依頼しました", status: "done", createdAt: 2, codeRequestId: "request", codeTaskId: "code-1", codeState: "running", codeActivity: "読取 README.md" }] },
    }));

    expect(screen.getByText("· 読取 README.md")).toBeTruthy();
    const log = screen.getByText("Code実行中").closest<HTMLDetailsElement>("[data-bot-tool-group]");
    expect(log?.open).toBe(true);
    expect(log?.querySelector("summary .lucide-scroll-text")?.getAttribute("aria-hidden")).toBe("true");
    expect(log?.querySelector("summary")?.textContent).toContain("作業ログ");
    expect(log?.parentElement?.nextElementSibling?.textContent).toContain("依頼しました");
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${room.id}/code`, { action: "abort", requestId: "request" });
    act(() => pushSnapshot({
      room: { ...room, messages: [{ id: "reply-9", role: "assistant", botId: bot.id, text: "依頼しました", status: "done", createdAt: 2, codeRequestId: "request", codeTaskId: "code-1", codeState: "cancelled" }] },
    }));
    expect(log?.querySelector('svg[aria-label="中断"]')).not.toBeNull();
    expect(log?.querySelector('svg[aria-label="完了"]')).toBeNull();
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

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alertdialog", { name: "Alphaの権限確認" })).toBeNull();

    // A stale snapshot that still carries the answered permission must not revive the card.
    act(() => pushSnapshot({
      room: { ...room, messages: [...room.messages, { id: "reply-1", role: "assistant", botId: bot.id, text: "修正を依頼しました", status: "done", createdAt: 2, codeRequestId: "request", codeTaskId: "code-1", codeState: "running" }] },
      attention: [{ botId: bot.id, taskId: `bot:${bot.id}:room:${room.id}`, permission, question: null }],
    }));
    expect(screen.queryByRole("alertdialog", { name: "Alphaの権限確認" })).toBeNull();
  });

  it("clears attention after resetting the room conversation", async () => {
    vi.stubGlobal("confirm", () => true);
    mocks.sendJson.mockResolvedValue({ room: { ...room, messages: [] } });
    render(<RoomView id={room.id} />);
    await screen.findByRole("textbox");
    const permission = { id: "permission-1", command: "code_session", message: "Codeへ依頼します", labels: [] };
    act(() => pushSnapshot({
      room,
      attention: [{ botId: bot.id, taskId: `bot:${bot.id}:room:${room.id}`, permission, question: null }],
    }));
    expect(screen.getByRole("alertdialog", { name: "Alphaの権限確認" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(await screen.findByRole("button", { name: "会話をリセット" }));
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(`/api/bots/rooms/${encodeURIComponent(room.id)}`, { resetMessages: true }, "PATCH");
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "Alphaの権限確認" })).toBeNull();
    });
  });
});

describe("RoomView notifications", () => {
  it("does not notify completion from the previous room after switching ids", async () => {
    const sent: string[] = [];
    class FakeNotification {
      static permission = "granted";
      constructor(title: string) { sent.push(title); }
    }
    class TestSource {
      static instances: TestSource[] = [];
      listeners = new Map<string, (event: MessageEvent) => void>();
      constructor() { TestSource.instances.push(this); }
      addEventListener(name: string, callback: (event: MessageEvent) => void) { this.listeners.set(name, callback); }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("EventSource", TestSource);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const roomOne = { ...room, id: "room-1", name: "One" };
    const roomTwo = { ...room, id: "room-2", name: "Two" };
    const busyRoom = { ...roomOne, messages: [...roomOne.messages, { id: "reply", role: "assistant" as const, botId: bot.id, text: "作業中", status: "working" as const, createdAt: 2 }] };
    const doneRoom = { ...roomTwo, messages: [...roomTwo.messages, { id: "reply", role: "assistant" as const, botId: bot.id, text: "完了", status: "done" as const, createdAt: 2 }] };
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots") return Promise.resolve({ bots: [bot] });
      if (path === "/api/bots/rooms/room-1") return Promise.resolve({ room: roomOne });
      if (path === "/api/bots/rooms/room-2") return Promise.resolve({ room: roomTwo });
      return Promise.resolve({ room: roomOne });
    });
    try {
      const view = render(<RoomView id="room-1" />);
      await screen.findByRole("heading", { name: "One" });
      const first = TestSource.instances[0];
      if (!first) throw new Error("Initial EventSource was not created");
      await act(async () => { first.listeners.get("snapshot")?.({ data: JSON.stringify({ room: busyRoom }) } as MessageEvent); });

      view.rerender(<RoomView id="room-2" />);
      await screen.findByRole("heading", { name: "Two" });
      const second = TestSource.instances[1];
      if (!second) throw new Error("Replacement EventSource was not created");
      await act(async () => { second.listeners.get("snapshot")?.({ data: JSON.stringify({ room: doneRoom }) } as MessageEvent); });
      expect(sent).toEqual([]);
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
  });

  it("notifies a hidden tab once per finished reply, unless every member Bot turned notifications off", async () => {
    const sent: string[] = [];
    class FakeNotification {
      static permission = "granted";
      constructor(title: string) { sent.push(title); }
    }
    vi.stubGlobal("Notification", FakeNotification);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const busyRoom = { ...room, messages: [...room.messages, { id: "reply", role: "assistant" as const, botId: bot.id, text: "作業中", status: "working" as const, createdAt: 2 }] };
    const doneRoom = { ...busyRoom, messages: busyRoom.messages.map((message) => message.id === "reply" ? { ...message, status: "done" as const } : message) };
    try {
      render(<RoomView id={room.id} />);
      await screen.findByRole("textbox");
      act(() => pushSnapshot({ room: busyRoom }));
      act(() => pushSnapshot({ room: doneRoom }));
      expect(sent).toEqual(["新しい返信があります"]);

      // 全メンバーが通知オフなら、ルームの通知も発火しない。
      mocks.getJson.mockImplementation((path: string) => path === "/api/bots" ? Promise.resolve({ bots: [{ ...bot, notificationsEnabled: false }] }) : Promise.resolve({ room }));
      cleanup();
      render(<RoomView id={room.id} />);
      await screen.findByRole("textbox");
      act(() => pushSnapshot({ room: busyRoom }));
      act(() => pushSnapshot({ room: doneRoom }));
      expect(sent).toEqual(["新しい返信があります"]);
      // 無効化されたメンバー（通知ON）と通知OFFの有効メンバーだけのRoomでは、答える側がミュートなので通知しない。
      mocks.getJson.mockImplementation((path: string) => path === "/api/bots" ? Promise.resolve({ bots: [{ ...bot, notificationsEnabled: false }, { id: "bot-2", name: "Beta", enabled: false, notificationsEnabled: true }] }) : Promise.resolve({ room: { ...room, members: [bot.id, "bot-2"] } }));
      cleanup();
      render(<RoomView id={room.id} />);
      await screen.findByRole("textbox");
      const members = [bot.id, "bot-2"];
      act(() => pushSnapshot({ room: { ...busyRoom, members } }));
      act(() => pushSnapshot({ room: { ...doneRoom, members } }));
      expect(sent).toEqual(["新しい返信があります"]);
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
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
  it("keeps a hidden active room unread until the document is visible", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    try {
      render(<RoomView id={room.id} active />);
      await screen.findByRole("textbox");
      expect(mocks.markRead).not.toHaveBeenCalled();

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(mocks.markRead).toHaveBeenCalledWith("room", room.id, 1);
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
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

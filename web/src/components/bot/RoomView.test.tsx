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
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
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

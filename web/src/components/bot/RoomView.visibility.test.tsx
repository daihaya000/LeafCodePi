// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), push: vi.fn(), markRead: vi.fn() }));

vi.mock("@/lib/bot-unread", () => ({ markRead: mocks.markRead }));
vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("@/spa/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/spa/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

import { RoomView } from "./RoomView";
import { setNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";

const room = {
  id: "room-1",
  name: "Team",
  members: ["bot-1"], botRelayEnabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [],
};

let opened = 0;

beforeEach(() => {
  setNotificationDeliveryEnabled(true);
  opened = 0;
  mocks.getJson.mockImplementation((path: string) =>
    path === "/api/bots" ? Promise.resolve({ bots: [] }) : Promise.resolve({ room }));
  class Stub {
    constructor() {
      opened += 1;
    }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("EventSource", Stub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.getJson.mockReset();
  mocks.sendJson.mockReset();
});

describe("RoomView SSE visibility", () => {
  it("does not connect while the Room pane is in the background", async () => {
    render(<RoomView id="room-1" active={false} />);

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(opened).toBe(0);
  });

  it("connects once the Room pane becomes visible", async () => {
    const { rerender } = render(<RoomView id="room-1" active={false} />);
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalled());
    expect(opened).toBe(0);

    rerender(<RoomView id="room-1" active />);

    await waitFor(() => expect(opened).toBe(1));
  });
});
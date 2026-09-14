import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listener: undefined as ((payload: Record<string, unknown>) => void) | undefined,
  unsubscribe: vi.fn(),
  subscribe: vi.fn((listener: (payload: Record<string, unknown>) => void) => {
    mocks.listener = listener;
    return mocks.unsubscribe;
  }),
}));
vi.mock("@/lib/pi/harness", () => ({ subscribeBotCodeSession: mocks.subscribe }));

import { GET } from "./route";

async function readEvent(response: Response): Promise<{ event: string; data: Record<string, unknown> }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended before an event");
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.indexOf("\n\n");
      if (end < 0) continue;
      const lines = buffer.slice(0, end).split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7).trim();
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event && data) return { event, data: JSON.parse(data) as Record<string, unknown> };
    }
  } finally {
    await reader.cancel();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = undefined;
});

describe("GET /api/bots/events", () => {
  it("streams Code session events and unsubscribes on disconnect", async () => {
    const response = await GET(new NextRequest("http://localhost/api/bots/events"));
    mocks.listener?.({ type: "snapshot", eventType: "code_session_changed", codeRequestId: "request-1" });

    await expect(readEvent(response)).resolves.toMatchObject({
      event: "snapshot",
      data: { eventType: "code_session_changed", codeRequestId: "request-1" },
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

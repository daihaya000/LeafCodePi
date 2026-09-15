import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveProviderLogin: vi.fn(),
  subscribeProviderLogin: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { GET } from "./route";

async function readEventTypes(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    content += decoder.decode(value, { stream: true });
  }
  return [...content.matchAll(/^event: (.+)$/gm)].map((match) => match[1]!);
}

describe("GET /api/providers/[id]/login/events", () => {
  it("does not replay the already-sent started event when subscribing", async () => {
    mocks.getActiveProviderLogin.mockReturnValue({
      providerId: "openai-codex",
      sessionId: "session-1",
      authType: "oauth",
      accountId: null,
    });
    mocks.subscribeProviderLogin.mockImplementation((listener) => {
      listener({ type: "started", providerId: "openai-codex", authType: "oauth" });
      listener({ type: "done", ok: true });
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://localhost/api/providers/openai-codex/login/events?sessionId=session-1"),
      { params: Promise.resolve({ id: "openai-codex" }) },
    );

    expect(await readEventTypes(response)).toEqual(["started", "done"]);
  });
});

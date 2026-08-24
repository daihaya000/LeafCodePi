import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  readSessionConversation: vi.fn(),
}));
const { getTask, readSessionConversation } = mocks;

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/direct-session", () => ({ readSessionConversation: mocks.readSessionConversation }));

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/next-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/tasks/[id]/next-action", () => {
  beforeEach(() => {
    getTask.mockReset();
    readSessionConversation.mockReset();
    vi.unstubAllGlobals();
    getTask.mockReturnValue({
      id: "task-1",
      sessionFile: "C:\\sessions\\task-1.jsonl",
      providerID: "llama-server",
      modelID: "local-model",
    });
    readSessionConversation.mockReturnValue([
      { role: "user", text: "APIを追加しました" },
      { role: "assistant", text: "テストが必要です" },
    ]);
  });

  it("reads the server-side session and returns a direct suggestion", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain("APIを追加しました");
      expect(body.messages[1].content).toContain("別案");
      return new Response(JSON.stringify({ choices: [{ message: { content: "テストを追加する" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        model: { providerID: "llama-server", modelID: "local-model" },
        previousSuggestions: ["別案"],
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suggestion: "テストを追加する",
      suggestions: ["テストを追加する"],
      source: "direct",
    });
    expect(readSessionConversation).toHaveBeenCalledWith("C:\\sessions\\task-1.jsonl");
  });

  it("does not accept a browser-supplied transcript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[1].content).toContain("APIを追加しました");
        expect(body.messages[1].content).not.toContain("client supplied");
        throw new Error("test failure");
      }),
    );
    const response = await POST(
      request({
        model: { providerID: "llama-server", modelID: "local-model" },
        messages: [{ role: "user", text: "client supplied" }],
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "直接生成に失敗しました: test failure" });
  });
});

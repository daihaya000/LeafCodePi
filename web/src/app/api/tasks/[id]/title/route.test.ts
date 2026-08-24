import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  patchTask: vi.fn(),
  readSessionConversation: vi.fn(),
}));
const { getTask, patchTask, readSessionConversation } = mocks;

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask, patchTask: mocks.patchTask }));
vi.mock("@/lib/direct-session", () => ({ readSessionConversation: mocks.readSessionConversation }));

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/title", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/tasks/[id]/title", () => {
  beforeEach(() => {
    getTask.mockReset();
    patchTask.mockReset();
    readSessionConversation.mockReset();
    vi.unstubAllGlobals();
    getTask.mockReturnValue({
      id: "task-1",
      title: "旧タイトル",
      sessionFile: "C:\\sessions\\task-1.jsonl",
      providerID: "llama-server",
      modelID: "local-model",
    });
    patchTask.mockReturnValue({ id: "task-1", title: "ログイン修正" });
    readSessionConversation.mockReturnValue([{ role: "user", text: "ログインを修正する" }]);
  });

  it("generates a title directly and persists it to the task store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "「ログイン修正」" } }] }), {
          status: 200,
        }),
      ),
    );

    const response = await POST(request({}), { params: Promise.resolve({ id: "task-1" }) });

    expect(response.status).toBe(200);
    expect(patchTask).toHaveBeenCalledWith("task-1", { title: "ログイン修正" });
    expect(await response.json()).toMatchObject({ title: "ログイン修正" });
  });
});

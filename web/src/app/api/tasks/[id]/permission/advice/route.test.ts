import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  pendingPermissionForTask: vi.fn(),
}));

vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/pi/harness", () => ({ pendingPermissionForTask: mocks.pendingPermissionForTask }));

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/permission/advice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/tasks/[id]/permission/advice", () => {
  beforeEach(() => {
    mocks.getSetting.mockReset();
    mocks.pendingPermissionForTask.mockReset();
    vi.unstubAllGlobals();
    mocks.getSetting.mockReturnValue("llama-server::advice-model");
    mocks.pendingPermissionForTask.mockReturnValue({
      id: "request-1",
      sessionId: "session-1",
      command: "rm -rf ./build",
      labels: ["rm -rf / rm --recursive"],
      message: "危険なコマンドを検出しました",
    });
  });

  it("uses the pending command and configured generation model", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("advice-model");
      expect(body.max_tokens).toBe(160);
      expect(body.chat_template_kwargs).toBeUndefined();
      expect(body.messages[0].content).toContain("第三者レビュアー");
      expect(body.messages[1].content).toContain("rm -rf ./build");
      return new Response(JSON.stringify({ choices: [{ message: { content: "実行前に内容と対象を確認してください。" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({ requestId: "request-1", command: "client supplied command" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      advice: "実行前に内容と対象を確認してください。",
      source: "direct",
      model: { providerID: "llama-server", modelID: "advice-model" },
    });
  });

  it("does not generate advice without a configured model", async () => {
    mocks.getSetting.mockReturnValue(null);

    const response = await POST(
      request({ requestId: "request-1" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "生成モデルが設定されていません" });
  });

  it("rejects a stale permission request", async () => {
    mocks.pendingPermissionForTask.mockReturnValue(null);

    const response = await POST(
      request({ requestId: "request-1" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(404);
  });
});

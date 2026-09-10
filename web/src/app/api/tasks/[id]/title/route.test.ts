import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH, POST } from "./route";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  patchTask: vi.fn(),
  readSessionConversation: vi.fn(),
  getSetting: vi.fn(),
}));
const { getTask, patchTask, readSessionConversation, getSetting } = mocks;

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask, patchTask: mocks.patchTask }));
vi.mock("@/lib/direct-session", () => ({ readSessionConversation: mocks.readSessionConversation }));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));

function request(body: unknown, method: "POST" | "PATCH" = "POST"): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/title", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/tasks/[id]/title", () => {
  beforeEach(() => {
    getTask.mockReset();
    patchTask.mockReset();
    readSessionConversation.mockReset();
    getSetting.mockReset();
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
    getSetting.mockReturnValue(null);
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
    expect(await response.json()).toMatchObject({
      title: "ログイン修正",
      model: { providerID: "llama-server", modelID: "local-model" },
    });
  });

  it("forwards the configured generation effort", async () => {
    getSetting.mockImplementation((key: string) => {
      if (key === "generation-model") return "llama-server::Qwen3.8-27B-Uncensored-GGUF";
      if (key === "generation-model-effort") return "medium";
      return null;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ログイン修正" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), { params: Promise.resolve({ id: "task-1" }) });

    expect(response.status).toBe(200);
  });

  it("tries the configured fallback model with its own effort", async () => {
    getSetting.mockImplementation((key: string) => {
      if (key === "generation-model") return "llama-server::primary-model";
      if (key === "generation-model-effort") return "low";
      if (key === "generation-fallback-model") return "llama-server::Qwen3.8-27B-Uncensored-GGUF";
      if (key === "generation-fallback-model-effort") return "medium";
      return null;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("Qwen3.8-27B-Uncensored-GGUF");
        expect(body.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
        return new Response(JSON.stringify({ choices: [{ message: { content: "フォールバックタイトル" } }] }), {
          status: 200,
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), { params: Promise.resolve({ id: "task-1" }) });

    expect(response.status).toBe(200);
    expect(patchTask).toHaveBeenCalledWith("task-1", { title: "フォールバックタイトル" });
    expect(await response.json()).toMatchObject({
      model: { providerID: "llama-server", modelID: "Qwen3.8-27B-Uncensored-GGUF" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-object request body before reading fields", async () => {
    const response = await POST(
      request(null),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
  });

  it("persists a manual title and disables automatic updates", async () => {
    patchTask.mockReturnValue({ id: "task-1", title: "手動タイトル", titleAutoUpdate: false });

    const response = await PATCH(
      request({ title: "  手動タイトル  " }, "PATCH"),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(patchTask).toHaveBeenCalledWith("task-1", {
      title: "手動タイトル",
      titleAutoUpdate: false,
    });
    expect(await response.json()).toMatchObject({
      title: "手動タイトル",
      task: { title: "手動タイトル", titleAutoUpdate: false },
    });
  });

  it("persists the automatic title update switch", async () => {
    patchTask.mockReturnValue({ id: "task-1", title: "旧タイトル", titleAutoUpdate: true });

    const response = await PATCH(
      request({ titleAutoUpdate: true }, "PATCH"),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(patchTask).toHaveBeenCalledWith("task-1", { titleAutoUpdate: true });
  });

  it("rejects an empty manual title", async () => {
    const response = await PATCH(
      request({ title: "  \n  " }, "PATCH"),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(patchTask).not.toHaveBeenCalled();
  });
});

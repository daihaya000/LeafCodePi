import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listTasks: vi.fn(),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitLogGraph: vi.fn(),
  gitBranchRefs: vi.fn(),
  getSetting: vi.fn(),
}));
const { getProject, listTasks, gitStatus, gitDiff, gitLogGraph, gitBranchRefs, getSetting } = mocks;

vi.mock("@/lib/store", () => ({ getProject: mocks.getProject, listTasks: mocks.listTasks }));
vi.mock("@/lib/git", () => ({
  gitStatus: mocks.gitStatus,
  gitDiff: mocks.gitDiff,
  gitLogGraph: mocks.gitLogGraph,
  gitBranchRefs: mocks.gitBranchRefs,
}));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/projects/project-1/next-task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/projects/[id]/next-task", () => {
  beforeEach(() => {
    getProject.mockReset();
    listTasks.mockReset();
    gitStatus.mockReset();
    gitDiff.mockReset();
    gitLogGraph.mockReset();
    gitBranchRefs.mockReset();
    getSetting.mockReset();
    vi.unstubAllGlobals();
    getProject.mockReturnValue({ id: "project-1", name: "LeafCodePi", rootPath: process.cwd() });
    listTasks.mockReturnValue([{ projectId: "project-1", title: "既存タスク", status: "idle" }]);
    gitStatus.mockResolvedValue(" M web/src/app.ts");
    gitDiff.mockResolvedValue("+new line");
    gitLogGraph.mockResolvedValue({ commits: [{ shortHash: "abc1234", subject: "初期実装" }] });
    gitBranchRefs.mockResolvedValue({ currentBranch: "main" });
    getSetting.mockReturnValue(null);
  });

  it("builds the direct prompt from repository state", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain("web/src/app.ts");
      expect(body.messages[1].content).toContain("既存タスク");
      return new Response(JSON.stringify({ choices: [{ message: { content: "APIのテストを追加する" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({ model: { providerID: "llama-server", modelID: "local-model" } }),
      { params: Promise.resolve({ id: "project-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      suggestion: "APIのテストを追加する",
      source: "direct",
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "次のタスクを作る" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({}),
      { params: Promise.resolve({ id: "project-1" }) },
    );

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
        return new Response(JSON.stringify({ choices: [{ message: { content: "フォールバックで次のタスク" } }] }), {
          status: 200,
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({}),
      { params: Promise.resolve({ id: "project-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      suggestion: "フォールバックで次のタスク",
      source: "direct",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

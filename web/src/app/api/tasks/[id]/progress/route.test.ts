import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LLAMA_SERVER_SETTINGS } from "@/lib/llama-server-settings";
import { POST } from "@backend-runtime/json-business/handlers/tasks/[id]/progress/route";
import { afterEach } from "vitest";
beforeEach(() => { vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach"); });
afterEach(() => vi.unstubAllEnvs());

const mocks = vi.hoisted(() => ({
  readTaskProgressSnapshot: vi.fn(),
  completeModelText: vi.fn(),
  listActiveLlamaAgentModels: vi.fn(() => [] as { taskId: string; providerID: string; modelID: string }[]),
  getSetting: vi.fn(),
  readSettingValue: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({
  readTaskProgressSnapshot: mocks.readTaskProgressSnapshot,
  completeModelText: mocks.completeModelText,
  listActiveLlamaAgentModels: mocks.listActiveLlamaAgentModels,
}));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));
// 実機の llama-server 設定を読まない。
vi.mock("@/lib/host-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host-control")>()),
  readSettingValue: mocks.readSettingValue,
}));

const { readTaskProgressSnapshot, getSetting, readSettingValue } = mocks;

function request(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1:3010/api/tasks/task-1/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

const context = { params: Promise.resolve({ id: "task-1" }) };

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: "task-1",
      title: "ログイン修正",
      status: "working",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    },
    messages: [
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        parts: [{ id: "u1-text", type: "text", text: "ログインのバグを直して" }],
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: 2,
        parts: [
          {
            id: "a1-tool",
            type: "tool",
            tool: "bash",
            callID: "call-1",
            state: { status: "running", input: { command: "npm test" } },
          },
        ],
      },
    ],
    todos: [],
    isStreaming: true,
    isCompacting: false,
    goalLoop: null,
    pendingPermission: null,
    pendingQuestion: null,
    ...overrides,
  };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("/api/tasks/[id]/progress", () => {
  beforeEach(() => {
    readTaskProgressSnapshot.mockReset();
    mocks.completeModelText.mockReset();
    getSetting.mockReset();
    readSettingValue.mockReset();
    readSettingValue.mockReturnValue(null);
    vi.unstubAllGlobals();
    readTaskProgressSnapshot.mockResolvedValue(snapshot());
    getSetting.mockImplementation((key: string) =>
      key === "generation-model" ? "llama-server::progress-model" : null,
    );
  });

  it("answers from the read-only session snapshot with the generation model", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("progress-model");
      expect(body.max_tokens).toBe(1_024);
      expect(body.messages[0].content).toContain("報告役");
      expect(body.messages[1].content).toContain("<work-log>");
      expect(body.messages[1].content).toContain("ログインのバグを直して");
      expect(body.messages[1].content).toContain("- コマンド(bash): npm test → 実行中");
      expect(body.messages[1].content).toContain("テストは通った？");
      return completion("- 作業中: テストを実行しています");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ question: "テストは通った？" }), context);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      answer: "- 作業中: テストを実行しています",
      question: "テストは通った？",
      model: { providerID: "llama-server", modelID: "progress-model" },
      source: "direct",
      working: true,
    });
    expect(typeof json.snapshotAt).toBe("number");
    expect(readTaskProgressSnapshot).toHaveBeenCalledWith("task-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for a summary when the question is blank", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[1].content).toContain("現在の進捗を要約してください。");
        return completion("要約");
      }),
    );

    const response = await POST(request({ question: "  " }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: "要約", question: "現在の進捗を要約してください。" });
  });

  it("falls back to the composer model when no generation model is configured", async () => {
    getSetting.mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).model).toBe("composer-model");
        return completion("回答");
      }),
    );

    const response = await POST(
      request({ model: { providerID: "llama-server", modelID: "composer-model" } }),
      context,
    );

    expect(response.status).toBe(200);
  });

  it("ignores a browser-supplied transcript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[1].content).not.toContain("client supplied");
        return completion("回答");
      }),
    );

    const response = await POST(
      request({ messages: [{ role: "user", text: "client supplied" }] }),
      context,
    );

    expect(response.status).toBe(200);
  });

  it("rejects an invalid question before reading the session", async () => {
    const tooLong = await POST(request({ question: "a".repeat(501) }), context);
    const notString = await POST(request({ question: 1 }), context);

    expect(tooLong.status).toBe(400);
    expect(notString.status).toBe(400);
    expect(readTaskProgressSnapshot).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing task", async () => {
    readTaskProgressSnapshot.mockRejectedValue(
      Object.assign(new Error("タスクが見つかりません"), { status: 404 }),
    );

    const response = await POST(request({}), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "タスクが見つかりません" });
  });

  it("returns 422 without calling the model when there is nothing to report", async () => {
    readTaskProgressSnapshot.mockResolvedValue(snapshot({ messages: [], isStreaming: false }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports generation failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));

    const response = await POST(request({}), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "プロバイダー応答エラー (503)" });
  });

  it("rejects a non-object request body", async () => {
    const response = await POST(request(null), context);

    expect(response.status).toBe(400);
    expect(readTaskProgressSnapshot).not.toHaveBeenCalled();
  });

  it("stops generating without trying the fallback when the browser disconnects", async () => {
    getSetting.mockImplementation((key: string) =>
      key === "generation-model"
        ? "llama-server::progress-model"
        : key === "generation-fallback-model"
          ? "llama-server::fallback-model"
          : null,
    );
    const browser = new AbortController();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
          browser.abort();
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}, browser.signal), context);

    expect(response.status).toBe(408);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("/api/tasks/[id]/progress with an agent on llama-server", () => {
  const localAgent = {
    id: "task-1",
    title: "ローカル作業",
    status: "working",
    providerID: "llama-server",
    modelID: "agent-model",
  };

  function useGenerationModels(primary: string, fallback: string | null = null) {
    getSetting.mockImplementation((key: string) =>
      key === "generation-model" ? primary : key === "generation-fallback-model" ? fallback : null,
    );
  }

  function useParallelSlots(parallel: number) {
    readSettingValue.mockImplementation((key: string) =>
      key === "llama-server-config" ? JSON.stringify({ ...DEFAULT_LLAMA_SERVER_SETTINGS, parallel }) : null,
    );
  }

  beforeEach(() => {
    readTaskProgressSnapshot.mockReset();
    mocks.completeModelText.mockReset();
    getSetting.mockReset();
    readSettingValue.mockReset();
    readSettingValue.mockReturnValue(null);
    vi.unstubAllGlobals();
    readTaskProgressSnapshot.mockResolvedValue(snapshot({ task: localAgent }));
  });

  it("does not queue behind the running agent on its only llama-server slot", async () => {
    useGenerationModels("llama-server::agent-model");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("llama-server");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a fallback model outside llama-server instead", async () => {
    useGenerationModels("llama-server::agent-model", "anthropic::claude-haiku");
    mocks.completeModelText.mockResolvedValue("クラウドで回答");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      answer: "クラウドで回答",
      model: { providerID: "anthropic", modelID: "claude-haiku" },
    });
    expect(mocks.completeModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerID: "anthropic",
        modelID: "claude-haiku",
        excludeProviderIDs: ["llama-server"],
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the agent's model when llama-server has a free parallel slot", async () => {
    useGenerationModels("llama-server::agent-model");
    useParallelSlots(2);
    const fetchMock = vi.fn(async () => completion("回答"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not load another local model next to the running agent", async () => {
    useGenerationModels("llama-server::other-model");
    useParallelSlots(4);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a Goal Loop waiting between turns as active", async () => {
    readTaskProgressSnapshot.mockResolvedValue(
      snapshot({ task: { ...localAgent, status: "idle" }, isStreaming: false, goalLoop: { status: "queued" } }),
    );
    useGenerationModels("llama-server::agent-model");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the local model while the agent is idle", async () => {
    readTaskProgressSnapshot.mockResolvedValue(
      snapshot({ task: { ...localAgent, status: "idle" }, isStreaming: false }),
    );
    useGenerationModels("llama-server::agent-model");
    const fetchMock = vi.fn(async () => completion("回答"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}), context);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

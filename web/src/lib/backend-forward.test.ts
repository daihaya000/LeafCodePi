import { describe, expect, it, vi } from "vitest";
import { readPendingRequestSnapshots } from "../../../backend/src/pending-requests.mjs";
import {
  forwardPermissionAnswer,
  forwardGoalLoopStart,
  forwardQuestionAnswer,
  forwardTaskAbort,
  forwardBotRevert,
  forwardBotRoutineRun,
  COMPACT_FORWARD_TIMEOUT_MS,
  forwardPendingAttention,
  forwardRoomAdmin,
  forwardRoomPrompt,
  forwardTaskCompact,
  forwardTaskCompactAbort,
  forwardTaskModel,
  forwardTaskThinking,
  forwardTaskAgent,
  forwardRoomRevert,
  forwardTaskRevert,
  forwardBotAdmin,
  forwardTaskAdmin,
  forwardProjectTeardown,
  forwardTaskTeardown,
  forwardTaskUnrevert,
  forwardPendingRequestsByTask,
  forwardTaskPendingRequests,
  forwardTaskDetail,
  forwardTaskPrompt,
  forwardablePromptBody,
  needsLocalResolution,
} from "./backend-forward";

const env = { LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40), LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:19999" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("forwardGoalLoopStart", () => {
  it("forwards selection fields and returns the owner's selection result", async () => {
    const autoDecision = { modelID: "selected-model" };
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      loop: { status: "queued" }, agent: "reviewer", autoDecision,
    }));
    const selection = {
      goal: "直す", acceptance: ["テスト成功"], auto: true, autoOptimize: "balanced",
      autoRouteOverrides: { heavy: "openai/gpt-5" }, model: "openai/gpt-5", thinkingLevel: "high", agent: "auto",
    };
    await expect(forwardGoalLoopStart("task-1", selection, { env, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ ok: true, loop: { status: "queued" }, agent: "reviewer", autoDecision });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/goal-loop");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ action: "start", ...selection });
  });

  it("marks a Bot start so the owner can initialize a missing Bot task", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { loop: { status: "queued" }, agent: null }));
    await forwardGoalLoopStart("bot:one", { botId: "one", goal: "調べる", acceptance: [] }, { env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/bot%3Aone/goal-loop");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ action: "start", botId: "one", goal: "調べる", acceptance: [] });
  });

  it("does not time out Auto selection at the ordinary 10s read deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (response: Response) => void;
      const fetchImpl = vi.fn<typeof fetch>(() =>
        new Promise<Response>((done) => { resolve = done; }));
      const pending = forwardGoalLoopStart("task-1", { goal: "直す", acceptance: [], agent: "auto" }, {
        env, fetchImpl: fetchImpl as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
      resolve(jsonResponse(200, { loop: { status: "queued" }, agent: "reviewer" }));
      await expect(pending).resolves.toMatchObject({ ok: true, agent: "reviewer" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([400, 409])("keeps owner refusal status %i", async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { error: "refused" }));
    const result = await forwardGoalLoopStart("task-1", { goal: "直す", acceptance: [], auto: true }, {
      env, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status });
  });
});

describe("forwardablePromptBody", () => {
  it("keeps only what the Backend's runtime understands", () => {
    expect(
      forwardablePromptBody({
        prompt: "こんにちは",
        model: "openai/gpt-5",
        thinkingLevel: "high",
        agent: "builder",
        streamingBehavior: "followUp",
        resume: true,
        auto: true,
        autoRetry: true,
        images: [{ mimeType: "image/png", data: "x" }],
        files: [],
        somethingElse: 1,
      }),
    ).toEqual({
      prompt: "こんにちは",
      model: "openai/gpt-5",
      thinkingLevel: "high",
      agent: "builder",
      streamingBehavior: "followUp",
      resume: true,
      images: [{ mimeType: "image/png", data: "x" }],
      files: [],
    });
    expect(forwardablePromptBody(null)).toEqual({});
    expect(forwardablePromptBody(undefined)).toEqual({});
  });

  it("flags the fields the WebUI has to resolve first", () => {
    expect(needsLocalResolution({ prompt: "hi" })).toBe(false);
    expect(needsLocalResolution(null)).toBe(false);
    for (const field of ["auto", "autoRetry", "autoOptimize", "autoRouteOverrides"]) {
      expect(needsLocalResolution({ [field]: true })).toBe(true);
    }
    expect(needsLocalResolution({ auto: undefined })).toBe(false);
  });
});

describe("forwardTaskPrompt", () => {
  it("posts to the owning Backend and returns its task summary", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { task: { id: "task-1", status: "working" } }));
    const result = await forwardTaskPrompt("task-1", { prompt: "hi", auto: true }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, task: { id: "task-1", status: "working" } });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/prompt");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ prompt: "hi" });
  });

  it("reports a failure instead of falling back locally", async () => {
    const cases: Array<[number | "throw", string]> = [
      [401, "unauthorized"],
      [409, "incompatible"],
      [500, "bad-response"],
      ["throw", "unreachable"],
    ];
    for (const [status, reason] of cases) {
      const fetchImpl =
        status === "throw"
          ? vi.fn(async () => { throw new Error("ECONNREFUSED"); })
          : vi.fn(async () => jsonResponse(status as number, { error: "nope" }));
      const result = await forwardTaskPrompt("task-1", { prompt: "hi" }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe(reason);
    }
    const unconfigured = await forwardTaskPrompt("task-1", { prompt: "hi" }, { env: {} });
    expect(unconfigured).toEqual({ ok: false, reason: "not-configured" });
  });

  it("treats a body without a task as an empty summary", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await expect(forwardTaskPrompt("task-1", { prompt: "hi" }, { env, fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({
      ok: true,
      task: null,
    });
  });
});

describe("forwardTaskDetail", () => {
  it("reads the detail from the Backend and reports its failures", async () => {
    const ok = vi.fn(async () => jsonResponse(200, { detail: { id: "task-1", status: "working" } }));
    await expect(forwardTaskDetail("task-1", { env, fetchImpl: ok as unknown as typeof fetch })).resolves.toEqual({
      ok: true,
      detail: { id: "task-1", status: "working" },
    });
    expect(ok.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/detail");
    const missing = vi.fn(async () => jsonResponse(404, { error: "Not found" }));
    const result = await forwardTaskDetail("task-1", { env, fetchImpl: missing as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not-found");
    expect(result.ok === false && result.status).toBe(404);
    const broken = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    const failed = await forwardTaskDetail("task-1", { env, fetchImpl: broken as unknown as typeof fetch });
    expect(failed.ok === false && failed.reason).toBe("bad-response");
    const unconfigured = await forwardTaskDetail("task-1", { env: {} });
    expect(unconfigured).toEqual({ ok: false, reason: "not-configured" });
  });

  it("treats a body without a detail as an empty detail", async () => {
    const empty = vi.fn(async () => jsonResponse(200, {}));
    await expect(forwardTaskDetail("task-1", { env, fetchImpl: empty as unknown as typeof fetch })).resolves.toEqual({
      ok: true,
      detail: null,
    });
  });
});

describe("forwarding answers", () => {
  it("posts the approval to the owning Backend", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    await expect(
      forwardPermissionAnswer("task-1", { requestId: "req-1", approved: true }, { env, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/permission");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ requestId: "req-1", approved: true });
  });

  it("keeps a rejection as a missing answer and reports a stale request as not-found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    await expect(
      forwardQuestionAnswer("task-1", { requestId: "q1" }, { env, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: true });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ requestId: "q1" });
    const stale = vi.fn(async () => jsonResponse(404, { error: "Question request not found" }));
    await expect(
      forwardQuestionAnswer("task-1", { requestId: "q1", answer: { answers: [["a"]] } }, { env, fetchImpl: stale as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: false, reason: "not-found", status: 404 });
    const failed = vi.fn(async () => jsonResponse(500, { error: "nope" }));
    await expect(
      forwardQuestionAnswer("task-1", { requestId: "q1" }, { env, fetchImpl: failed as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: false, reason: "bad-response", status: 500 });
    await expect(forwardQuestionAnswer("task-1", { requestId: "q1" }, { env: {} })).resolves.toEqual({ ok: false, reason: "not-configured" });
  });
});

describe("forwardTaskAbort", () => {
  it("stops the session in the Backend and keeps the Bot id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { task: { id: "t1", status: "error" } }));
    await expect(
      forwardTaskAbort("t1", { botId: "bot-1", env, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: true, task: { id: "t1", status: "error" } });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/t1/abort");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ botId: "bot-1" });
  });

  it("sends no Bot id for an ordinary task, and maps 404 to not-found", async () => {
    const ok = vi.fn(async () => jsonResponse(200, { task: { id: "t1" } }));
    await forwardTaskAbort("t1", { env, fetchImpl: ok as unknown as typeof fetch });
    expect(JSON.parse(String(ok.mock.calls[0][1]?.body))).toEqual({});
    const missing = vi.fn(async () => jsonResponse(404, { error: "Task not found" }));
    await expect(forwardTaskAbort("t1", { env, fetchImpl: missing as unknown as typeof fetch })).resolves.toEqual({
      ok: false,
      reason: "not-found",
      status: 404,
    });
    await expect(forwardTaskAbort("t1", { env: {} })).resolves.toEqual({ ok: false, reason: "not-configured" });
  });
});

describe("forwardTaskCompact", () => {
  it("forwards the instructions and keeps a long deadline for summarization", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (response: Response) => void;
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
      const pending = forwardTaskCompact("task-1", "要点だけ", { env, fetchImpl });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
      expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/compact");
      expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ customInstructions: "要点だけ" });
      resolve(jsonResponse(200, { task: { id: "task-1", isCompacting: true } }));
      await expect(pending).resolves.toEqual({ ok: true, task: { id: "task-1", isCompacting: true } });
      expect(COMPACT_FORWARD_TIMEOUT_MS).toBeGreaterThan(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no instructions when none were given and stops a running compaction", async () => {
    const compact = vi.fn<typeof fetch>(async () => jsonResponse(200, { task: { id: "task-1" } }));
    await forwardTaskCompact("task-1", undefined, { env, fetchImpl: compact });
    expect(JSON.parse(String(compact.mock.calls[0][1]?.body))).toEqual({});
    const abort = vi.fn<typeof fetch>(async () => jsonResponse(200, { task: { id: "task-1", isCompacting: false } }));
    await expect(forwardTaskCompactAbort("task-1", { env, fetchImpl: abort })).resolves.toEqual({
      ok: true, task: { id: "task-1", isCompacting: false },
    });
    expect(abort.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/compact/abort");
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "Not found" }));
    await expect(forwardTaskCompactAbort("task-1", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
  });
});

describe("forwardTaskModel / forwardTaskThinking / forwardTaskAgent", () => {
  it.each([
    [forwardTaskModel, "model", { model: "chosen" }, "model"],
    [forwardTaskThinking, "thinking", { thinkingLevel: "high" }, "thinkingLevel"],
    [forwardTaskAgent, "agent", { agent: "" }, "agent"],
  ] as const)("forwards a %s change to the owner", async (forward, path, body, field) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { task: { id: "task-1", [field]: body[field as keyof typeof body] } }));
    const value = String(body[field as keyof typeof body]);
    await expect(forward("task-1", value, { env, fetchImpl })).resolves.toEqual({
      ok: true,
      task: { id: "task-1", [field]: value },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:19999/internal/tasks/task-1/${path}`);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ [field]: value });
  });

  it("keeps a miss as not-found and reports an unreachable owner", async () => {
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "Not found" }));
    await expect(forwardTaskModel("task-1", "chosen", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardTaskThinking("task-1", "high", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardRoomAdmin", () => {
  it("replays the owner's status and body for PATCH and DELETE", async () => {
    const patch = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { status: 400, body: { error: "ルーム設定が不正です" } } }));
    await expect(forwardRoomAdmin("PATCH", "room-1", { resetMessages: true }, { env, fetchImpl: patch })).resolves.toEqual({
      ok: true, result: { status: 400, body: { error: "ルーム設定が不正です" } },
    });
    expect(patch.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/rooms/room-1");
    expect(patch.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(patch.mock.calls[0][1]?.body))).toEqual({ resetMessages: true });
    const remove = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { status: 200, body: { ok: true } } }));
    await expect(forwardRoomAdmin("DELETE", "room-1", null, { env, fetchImpl: remove })).resolves.toEqual({
      ok: true, result: { status: 200, body: { ok: true } },
    });
    expect(remove.mock.calls[0][1]?.method).toBe("DELETE");
    expect(remove.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("reports a transport failure without a local fallback", async () => {
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardRoomAdmin("PATCH", "room-1", {}, { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
    await expect(forwardRoomAdmin("DELETE", "room-1", null, { env: {} })).resolves.toEqual({
      ok: false, reason: "not-configured",
    });
  });
});

describe("forwardRoomPrompt", () => {
  it("replays the owner's status and body from the nested result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, {
      result: { status: 413, body: { error: "本文プロンプトが長すぎます" } },
    }));
    await expect(forwardRoomPrompt("room-1", { prompt: "長い" }, { env, fetchImpl })).resolves.toEqual({
      ok: true,
      result: { status: 413, body: { error: "本文プロンプトが長すぎます" } },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/rooms/room-1/prompt");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ prompt: "長い" });
  });

  it("sends an empty object for a missing body and reports a transport failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { status: 400, body: { error: "Prompt is required" } } }));
    await expect(forwardRoomPrompt("room-1", null, { env, fetchImpl })).resolves.toEqual({
      ok: true, result: { status: 400, body: { error: "Prompt is required" } },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({});
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardRoomPrompt("room-1", { prompt: "x" }, { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardPendingAttention", () => {
  it("returns the owner's attention items", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, {
      items: [{ taskId: "task-1", title: "first", kinds: ["permission"] }],
    }));
    await expect(forwardPendingAttention({ env, fetchImpl })).resolves.toEqual({
      ok: true,
      items: [{ taskId: "task-1", title: "first", kinds: ["permission"] }],
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/attention");
  });

  it("reports a failure instead of an empty local list", async () => {
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardPendingAttention({ env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(200, {}));
    await expect(forwardPendingAttention({ env, fetchImpl: missing })).resolves.toEqual({ ok: true, items: [] });
    await expect(forwardPendingAttention({ env: {} })).resolves.toEqual({ ok: false, reason: "not-configured" });
  });
});

describe("forwardTaskAdmin", () => {
  it("returns the owner's own status and body, and refuses a malformed answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { status: 409, body: { error: "使用中" } } }));
    await expect(forwardTaskAdmin("task-1", { action: "handoff", botId: "bot-1" }, { env, fetchImpl })).resolves.toEqual({
      ok: true, status: 409, body: { error: "使用中" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/admin");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ action: "handoff", botId: "bot-1" });
    const malformed = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: {} }));
    await expect(forwardTaskAdmin("task-1", { action: "release" }, { env, fetchImpl: malformed })).resolves.toEqual({
      ok: false, reason: "bad-response",
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardTaskAdmin("task-1", { action: "release" }, { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardBotAdmin", () => {
  it("returns the owner's own status and body, and refuses a malformed answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { status: 400, body: { error: "不正" } } }));
    await expect(forwardBotAdmin("bot-1", { action: "patch", body: { enabled: false } }, { env, fetchImpl })).resolves.toEqual({
      ok: true, status: 400, body: { error: "不正" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/bots/bot-1/admin");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ action: "patch", body: { enabled: false } });
    const malformed = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: {} }));
    await expect(forwardBotAdmin("bot-1", { action: "delete" }, { env, fetchImpl: malformed })).resolves.toEqual({
      ok: false, reason: "bad-response",
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardBotAdmin("bot-1", { action: "delete" }, { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardProjectTeardown", () => {
  it("returns the owner's own status and body, and refuses a malformed answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { status: 404, body: { error: "無い" } } }));
    await expect(forwardProjectTeardown("project-1", { action: "destroy" }, { env, fetchImpl })).resolves.toEqual({
      ok: true, status: 404, body: { error: "無い" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/projects/project-1/teardown");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ action: "destroy" });
    const malformed = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: {} }));
    await expect(forwardProjectTeardown("project-1", { action: "archive" }, { env, fetchImpl: malformed })).resolves.toEqual({
      ok: false, reason: "bad-response",
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardProjectTeardown("project-1", { action: "archive" }, { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardTaskTeardown", () => {
  it("asks the owner to archive or delete, and keeps a miss as not-found", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { result: { ok: true } }));
    await expect(forwardTaskTeardown("task-1", "destroy", { env, fetchImpl })).resolves.toEqual({
      ok: true, result: { ok: true },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/teardown");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ mode: "destroy" });
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "x" }));
    await expect(forwardTaskTeardown("task-1", "archive", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardTaskTeardown("task-1", "archive", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardTaskRevert and forwardTaskUnrevert", () => {
  it("returns the rewind the owner performed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { task: { id: "task-1" }, text: "戻した" }));
    await expect(forwardTaskRevert("task-1", "entry-1", { env, fetchImpl })).resolves.toEqual({
      ok: true, result: { task: { id: "task-1" }, text: "戻した" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/revert");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ entryId: "entry-1" });
  });

  it("returns the restored task and keeps a miss as not-found", async () => {
    const restored = vi.fn<typeof fetch>(async () => jsonResponse(200, { task: { id: "task-1", revertLeafId: null } }));
    await expect(forwardTaskUnrevert("task-1", { env, fetchImpl: restored })).resolves.toEqual({
      ok: true, task: { id: "task-1", revertLeafId: null },
    });
    expect(restored.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task-1/unrevert");
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "Not found" }));
    await expect(forwardTaskRevert("task-1", "entry-1", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardTaskUnrevert("task-1", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardRoomRevert", () => {
  it("returns the rewind the owner performed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, {
      text: "やり直したい依頼",
      images: [{ file: "room-1-0.png", mimeType: "image/png" }],
      files: [],
      cancelledCodeRequests: 2,
    }));
    await expect(forwardRoomRevert("room-1", "message-1", { env, fetchImpl })).resolves.toEqual({
      ok: true,
      result: {
        text: "やり直したい依頼",
        images: [{ file: "room-1-0.png", mimeType: "image/png" }],
        files: [],
        cancelledCodeRequests: 2,
      },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/rooms/room-1/revert");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ messageId: "message-1" });
  });

  it("keeps a miss as not-found and reports an unreachable owner", async () => {
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "Not found" }));
    await expect(forwardRoomRevert("room-1", "message-1", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardRoomRevert("room-1", "message-1", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });

  it("treats a body without rewind fields as an empty result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, {}));
    await expect(forwardRoomRevert("room-1", "message-1", { env, fetchImpl })).resolves.toEqual({
      ok: true,
      result: { text: "", images: [], files: [], cancelledCodeRequests: 0 },
    });
  });
});

describe("forwardBotRevert", () => {
  it("returns the rewind the owner performed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, {
      task: { id: "bot:bot-1" }, text: "戻した", images: [], files: [], cancelledCodeRequests: 1,
    }));
    await expect(forwardBotRevert("bot-1", "entry-1", { env, fetchImpl })).resolves.toEqual({
      ok: true,
      result: { task: { id: "bot:bot-1" }, text: "戻した", images: [], files: [], cancelledCodeRequests: 1 },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/bots/bot-1/revert");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ entryId: "entry-1" });
  });

  it("keeps a miss as not-found and reports an unreachable owner", async () => {
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "Not found" }));
    await expect(forwardBotRevert("bot-1", "entry-1", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardBotRevert("bot-1", "entry-1", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false, reason: "unreachable",
    });
  });
});

describe("forwardBotRoutineRun", () => {
  it("returns the routine the owner ran", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { routine: { id: "routine-1", name: "朝の確認" } }));
    await expect(forwardBotRoutineRun("bot-1", "routine-1", { env, fetchImpl })).resolves.toEqual({
      ok: true,
      routine: { id: "routine-1", name: "朝の確認" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/bots/bot-1/routines/routine-1");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("POST");
  });

  it("keeps a miss as not-found and never falls back to the in-process run", async () => {
    const missing = vi.fn<typeof fetch>(async () => jsonResponse(404, { error: "Routine not found" }));
    await expect(forwardBotRoutineRun("bot-1", "none", { env, fetchImpl: missing })).resolves.toEqual({
      ok: false,
      reason: "not-found",
      status: 404,
    });
    const unreachable = vi.fn<typeof fetch>(async () => { throw new Error("connect refused"); });
    await expect(forwardBotRoutineRun("bot-1", "routine-1", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
    await expect(forwardBotRoutineRun("bot-1", "routine-1", { env: {} })).resolves.toEqual({
      ok: false,
      reason: "not-configured",
    });
  });
});

describe("forwardTaskPendingRequests", () => {
  it("reads the actual owner snapshot contract for both task and Room consumers", async () => {
    let permission: { id: string } | null = { id: "p1" };
    let question: { id: string } | null = { id: "q1" };
    const runtime = {
      listPendingAttention: () => [{ taskId: "code-1", originTaskId: "bot:room:one" }],
      pendingPermissionForTask: () => permission,
      pendingQuestionForTask: () => question,
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { snapshots: readPendingRequestSnapshots(runtime) }));
    const options = { env, fetchImpl };
    await expect(forwardTaskPendingRequests("code-1", options)).resolves.toEqual({
      permissionRequest: permission, questionRequest: question,
    });
    await expect(forwardPendingRequestsByTask(options)).resolves.toEqual({
      "code-1": { permissionRequest: permission, questionRequest: question },
      "bot:room:one": { permissionRequest: permission, questionRequest: question },
    });
    permission = null;
    question = null;
    await expect(forwardTaskPendingRequests("code-1", options)).resolves.toEqual({
      permissionRequest: null, questionRequest: null,
    });
    await expect(forwardPendingRequestsByTask(options)).resolves.toEqual({});
  });

  it("reads the pending request the owning Backend is waiting on", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        snapshots: [
          { taskId: "other", payload: { permissionRequest: { requestId: "nope" } } },
          { taskId: "task-1", payload: { permissionRequest: { requestId: "req-1" }, questionRequest: { requestId: "q1" } } },
        ],
      }),
    );
    await expect(
      forwardTaskPendingRequests("task-1", { env, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ permissionRequest: { requestId: "req-1" }, questionRequest: { requestId: "q1" } });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/pending-snapshots");
  });

  it("reports nothing pending when the task is absent or the Backend cannot answer", async () => {
    const empty = vi.fn(async () => jsonResponse(200, { snapshots: [] }));
    await expect(
      forwardTaskPendingRequests("task-1", { env, fetchImpl: empty as unknown as typeof fetch }),
    ).resolves.toEqual({ permissionRequest: null, questionRequest: null });
    const broken = vi.fn(async () => jsonResponse(500, {}));
    await expect(
      forwardTaskPendingRequests("task-1", { env, fetchImpl: broken as unknown as typeof fetch }),
    ).resolves.toEqual({ permissionRequest: null, questionRequest: null });
    await expect(forwardTaskPendingRequests("task-1", { env: {} })).resolves.toEqual({
      permissionRequest: null,
      questionRequest: null,
    });
  });
});

describe("forwardPendingRequestsByTask", () => {
  it("keys every pending request by task id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        snapshots: [
          { taskId: "t1", payload: { permissionRequest: { requestId: "p1" } } },
          { taskId: "t2", payload: { questionRequest: { requestId: "q1" } } },
          { taskId: "", payload: {} },
          { payload: { permissionRequest: { requestId: "ignored" } } },
        ],
      }),
    );
    await expect(
      forwardPendingRequestsByTask({ env, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({
      t1: { permissionRequest: { requestId: "p1" }, questionRequest: null },
      t2: { permissionRequest: null, questionRequest: { requestId: "q1" } },
    });
  });

  it("is empty when the Backend cannot answer", async () => {
    const broken = vi.fn(async () => jsonResponse(500, {}));
    await expect(forwardPendingRequestsByTask({ env, fetchImpl: broken as unknown as typeof fetch })).resolves.toEqual({});
    await expect(forwardPendingRequestsByTask({ env: {} })).resolves.toEqual({});
  });
});

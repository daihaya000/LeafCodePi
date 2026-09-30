import { describe, expect, it, vi } from "vitest";
import { forwardTaskDetail, forwardTaskPrompt, forwardablePromptBody, needsLocalResolution } from "./backend-forward";

const env = { LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40), LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:19999" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
    expect(result.ok === false && result.reason).toBe("bad-response");
    expect(result.ok === false && result.status).toBe(404);
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

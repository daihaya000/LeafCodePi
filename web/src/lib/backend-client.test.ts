import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";
import {
  backendBaseUrl,
  backendClientStatus,
  expectedBackendGeneration,
  fetchBackendJson,
  isBackendGenerationCompatible,
  readBackendHealth,
  readBackendTasks,
  readBackendTaskDetail,
} from "./backend-client";

const env = { LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40), LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:19999/" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("backendClientStatus", () => {
  it("reports whether a token is configured and which base URL is used", () => {
    expect(backendClientStatus({})).toEqual({ configured: false, url: "http://127.0.0.1:18776" });
    expect(backendClientStatus(env)).toEqual({ configured: true, url: "http://127.0.0.1:19999" });
    // A blank token is not configured, and a blank URL falls back to the default port.
    expect(backendClientStatus({ LEAFCODE_PI_BACKEND_TOKEN: "  ", LEAFCODE_PI_BACKEND_URL: " " })).toEqual({
      configured: false,
      url: "http://127.0.0.1:18776",
    });
  });

  it("normalizes a trailing slash on the base URL", () => {
    expect(backendBaseUrl({ LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:19999///" })).toBe("http://127.0.0.1:19999");
  });
});

describe("fetchBackendJson", () => {
  it("distinguishes an input conflict from a protocol refusal", async () => {
    for (const [code, reason] of [["BACKEND_BAD_REQUEST", "bad-response"], ["BACKEND_INTERNAL_ERROR", "bad-response"], ["BACKEND_PROTOCOL_MISMATCH", "incompatible"]]) {
      const fetchImpl = vi.fn(async () => jsonResponse(409, { code }));
      await expect(fetchBackendJson("/internal/tasks/task-1/detail?messages=page", { env, fetchImpl })).resolves.toEqual({
        ok: false, reason, status: 409,
      });
    }
    const fetchImpl = vi.fn(async () => new Response("invalid JSON", { status: 409 }));
    await expect(fetchBackendJson("/internal/health", { env, fetchImpl })).resolves.toEqual({
      ok: false, reason: "incompatible", status: 409,
    });
  });

  it("refuses to call anything without a token", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchBackendJson("/internal/health", { env: {}, fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "not-configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the bearer token and protocol header and returns the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ready: true, status: "ready", pid: 1 }));
    const result = await fetchBackendJson<{ ready: boolean }>("/internal/health", { env, fetchImpl });
    expect(result).toEqual({ ok: true, status: 200, body: { ready: true, status: "ready", pid: 1 } });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:19999/internal/health");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`);
    expect((init.headers as Record<string, string>)[BACKEND_PROTOCOL_HEADER]).toBe(String(BACKEND_PROTOCOL_VERSION));
  });

  it("maps each refusal to its own reason", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [409, "incompatible"],
      [404, "bad-response"],
      [500, "bad-response"],
    ];
    for (const [status, reason] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { code: "X" }));
      const result = await fetchBackendJson("/internal/health", { env, fetchImpl });
      expect(result).toEqual({ ok: false, reason, status });
    }
  });

  it("separates an unreachable Backend from a timeout", async () => {
    const unreachable = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(fetchBackendJson("/internal/health", { env, fetchImpl: unreachable })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
    const aborted = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    await expect(fetchBackendJson("/internal/health", { env, fetchImpl: aborted })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("treats a body that is not JSON as a bad response", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>nope</html>", { status: 200 }));
    await expect(fetchBackendJson("/internal/health", { env, fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "bad-response",
      status: 200,
    });
  });

  it("aborts a request that runs past its budget", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }));
    const result = await fetchBackendJson("/internal/health", { env, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it.each([200, 409])("keeps the deadline active while a %s response body is stalled", async (status) => {
    vi.useFakeTimers();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("deadline", "AbortError")), { once: true });
      },
    }), { status }));
    const promise = fetchBackendJson("/internal/health", { env, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 100 });
    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    const settledAtDeadline = settled;
    // Finish the old implementation too, so a failed regression never leaves a hanging read.
    if (!settled) bodyController.error(new Error("test cleanup"));
    const result = await promise;
    expect(settledAtDeadline).toBe(true);
    expect(result).toEqual({ ok: false, reason: "timeout", status });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a successful body read", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    await expect(fetchBackendJson("/internal/health", { env, fetchImpl, timeoutMs: 100 })).resolves.toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("readers", () => {
  it("opts into history paging without changing ordinary detail reads", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>().mockImplementation(async () => jsonResponse(200, { detail: { messages: [] } }));
    const options = { env, fetchImpl: fetchImpl as unknown as typeof fetch };
    await readBackendTaskDetail("task/1", options);
    await readBackendTaskDetail("task/1", { ...options, messages: "page" });
    await readBackendTaskDetail("task/1", { ...options, messages: "page", before: "cursor?&+/ 日本語" });
    await readBackendTaskDetail("task/1", { ...options, messages: "page", limit: 300 });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/tasks/task%2F1/detail");
    expect(fetchImpl.mock.calls[1][0]).toBe("http://127.0.0.1:19999/internal/tasks/task%2F1/detail?messages=page");
    const older = new URL(fetchImpl.mock.calls[2][0]);
    expect(older.searchParams.get("messages")).toBe("page");
    expect(older.searchParams.get("before")).toBe("cursor?&+/ 日本語");
    const sized = new URL(fetchImpl.mock.calls[3][0]);
    expect(sized.searchParams.get("messages")).toBe("page");
    expect(sized.searchParams.get("limit")).toBe("300");
  });

  it("reads health and the task list from their paths", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/internal/tasks")
        ? jsonResponse(200, { tasks: [{ id: "t1" }] })
        : jsonResponse(200, { ready: true, status: "ready", pid: 7 }));
    await expect(readBackendHealth({ env, fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({
      ok: true,
      status: 200,
      body: { ready: true, status: "ready", pid: 7 },
    });
    await expect(readBackendTasks({ env, fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({
      ok: true,
      status: 200,
      body: { tasks: [{ id: "t1" }] },
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:19999/internal/health",
      "http://127.0.0.1:19999/internal/tasks",
    ]);
  });
});

describe("runtime generation", () => {
  it("reads the pinned generation from the environment", () => {
    expect(expectedBackendGeneration({ LEAFCODE_PI_BACKEND_GENERATION: " gen-a " })).toBe("gen-a");
    expect(expectedBackendGeneration({})).toBe("");
    expect(expectedBackendGeneration({ LEAFCODE_PI_BACKEND_GENERATION: "   " })).toBe("");
  });

  it("follows Host-published generations without restarting the WebUI", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcp-client-generation-"));
    try {
      const file = join(dir, "generation.txt");
      const clientEnv = { LEAFCODE_PI_BACKEND_GENERATION: "old", LEAFCODE_PI_BACKEND_GENERATION_FILE: file };
      expect(expectedBackendGeneration(clientEnv)).toBe("old");
      writeFileSync(file, "gen-a");
      expect(expectedBackendGeneration(clientEnv)).toBe("gen-a");
      writeFileSync(file, "gen-b");
      expect(expectedBackendGeneration(clientEnv)).toBe("gen-b");
      writeFileSync(file, "");
      expect(expectedBackendGeneration(clientEnv)).toBe("old");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("treats an unpinned expectation as compatible, and an unidentified Backend as not", () => {
    expect(isBackendGenerationCompatible("", "gen-b")).toBe(true);
    expect(isBackendGenerationCompatible("", null)).toBe(true);
    expect(isBackendGenerationCompatible("gen-a", "gen-a")).toBe(true);
    expect(isBackendGenerationCompatible("gen-a", "gen-b")).toBe(false);
    expect(isBackendGenerationCompatible("gen-a", null)).toBe(false);
    expect(isBackendGenerationCompatible("gen-a", undefined)).toBe(false);
    expect(isBackendGenerationCompatible("gen-a", "")).toBe(false);
  });
});

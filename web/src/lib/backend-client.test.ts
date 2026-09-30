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
  it("refuses to call anything without a token", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchBackendJson("/internal/health", { env: {}, fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "not-configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the bearer token and protocol header and returns the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ready: true, status: "ready", pid: 1 }));
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
});

describe("readers", () => {
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

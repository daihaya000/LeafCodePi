import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backendClientStatus: vi.fn(),
  readBackendHealth: vi.fn(),
  expectedBackendGeneration: vi.fn(() => ""),
  webUiAuthRequired: vi.fn(),
  isWebUiRequestAuthorized: vi.fn(),
}));
vi.mock("@/lib/backend-client", () => ({
  backendClientStatus: mocks.backendClientStatus,
  readBackendHealth: mocks.readBackendHealth,
  expectedBackendGeneration: mocks.expectedBackendGeneration,
  // The real check is exercised in backend-client's own tests; here it only feeds the summary.
  isBackendGenerationCompatible: (expected: string, running: string | null | undefined) =>
    !expected || expected === running,
}));
vi.mock("@/lib/backend-relay", () => ({
  isBackendRelayEnabled: vi.fn(() => false),
  webOwnsRuntime: vi.fn(() => true),
}));
vi.mock("@/lib/webui-auth", () => ({
  webUiAuthRequired: mocks.webUiAuthRequired,
  isWebUiRequestAuthorized: mocks.isWebUiRequestAuthorized,
}));

import { GET } from "./route";

function request() {
  return new Request("http://127.0.0.1:3010/api/backend/status");
}

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("GET /api/backend/status", () => {
  it("reports an unconfigured Backend without calling it", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: false, url: "http://127.0.0.1:18776" });
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: false,
      url: "http://127.0.0.1:18776",
      backend: null,
    });
  });

  it("summarizes a reachable Backend and its readiness", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    mocks.readBackendHealth.mockResolvedValue({
      ok: true,
      status: 200,
      body: { ready: true, status: "ready", pid: 4242, runtimeGeneration: "gen-a" },
    });
    mocks.expectedBackendGeneration.mockReturnValue("gen-a");
    const body = await (await GET(request())).json();
    expect(body).toEqual({
      configured: true,
      url: "http://127.0.0.1:18776",
      // The relay is off and this process still owns the runtime: the pre-cutover state is consistent.
      cutover: { ok: true, blockers: [] },
      backend: {
        reachable: true,
        ready: true,
        status: "ready",
        generation: { expected: "gen-a", running: "gen-a", matches: true },
      },
    });
    // The token and the Backend's pid are not part of the browser-visible contract.
    expect(JSON.stringify(body)).not.toContain("4242");
  });

  it("shows a generation mismatch and an unpinned expectation", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    mocks.readBackendHealth.mockResolvedValue({
      ok: true,
      status: 200,
      body: { ready: true, status: "ready", pid: 4242, runtimeGeneration: "gen-b" },
    });
    mocks.expectedBackendGeneration.mockReturnValue("gen-a");
    const body = await (await GET(request())).json();
    expect(body.backend.generation).toEqual({ expected: "gen-a", running: "gen-b", matches: false });
    expect(body.cutover).toEqual({ ok: false, blockers: ["generation-mismatch"] });
    mocks.expectedBackendGeneration.mockReturnValue("");
    const unpinned = await (await GET(request())).json();
    expect(unpinned.backend.generation).toEqual({ expected: null, running: "gen-b", matches: true });
  });

  it("reports a satisfied cutover preflight once the runtime is handed over", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    mocks.readBackendHealth.mockResolvedValue({
      ok: true,
      status: 200,
      body: { ready: true, status: "ready", pid: 4242, runtimeGeneration: "gen-a" },
    });
    mocks.expectedBackendGeneration.mockReturnValue("gen-a");
    const { isBackendRelayEnabled, webOwnsRuntime } = await import("@/lib/backend-relay");
    vi.mocked(isBackendRelayEnabled).mockReturnValue(true);
    vi.mocked(webOwnsRuntime).mockReturnValue(false);
    const body = await (await GET(request())).json();
    expect(body.cutover).toEqual({ ok: true, blockers: [] });
  });

  it("reports an unreachable Backend with its reason instead of failing", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    mocks.readBackendHealth.mockResolvedValue({ ok: false, reason: "unreachable" });
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: true,
      url: "http://127.0.0.1:18776",
      cutover: { ok: false, blockers: ["backend-unreachable"] },
      backend: { reachable: false, ready: false, status: null, reason: "unreachable" },
    });
  });

  it("keeps the endpoint behind the WebUI auth gate when it is required", async () => {
    mocks.webUiAuthRequired.mockReturnValue(true);
    mocks.isWebUiRequestAuthorized.mockReturnValue(false);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.backendClientStatus).not.toHaveBeenCalled();
    mocks.isWebUiRequestAuthorized.mockReturnValue(true);
    mocks.backendClientStatus.mockReturnValue({ configured: false, url: "http://127.0.0.1:18776" });
    expect((await GET(request())).status).toBe(200);
  });
});

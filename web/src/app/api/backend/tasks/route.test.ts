import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backendClientStatus: vi.fn(),
  readBackendTasks: vi.fn(),
  webUiAuthRequired: vi.fn(),
  isWebUiRequestAuthorized: vi.fn(),
}));
vi.mock("@/lib/backend-client", () => ({
  backendClientStatus: mocks.backendClientStatus,
  readBackendTasks: mocks.readBackendTasks,
}));
vi.mock("@/lib/webui-auth", () => ({
  webUiAuthRequired: mocks.webUiAuthRequired,
  isWebUiRequestAuthorized: mocks.isWebUiRequestAuthorized,
}));

import { GET } from "./route";

function request() {
  return new Request("http://127.0.0.1:3010/api/backend/tasks");
}

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("GET /api/backend/tasks", () => {
  it("answers 503 with a reason when the Backend is not configured", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: false, url: "http://127.0.0.1:18776" });
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Backendが設定されていません",
      reason: "not-configured",
    });
    expect(mocks.readBackendTasks).not.toHaveBeenCalled();
  });

  it("relays the Backend's task view and marks its source", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    mocks.readBackendTasks.mockResolvedValue({
      ok: true,
      status: 200,
      body: { tasks: [{ id: "t1", title: "from backend" }] },
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      source: "backend",
      tasks: [{ id: "t1", title: "from backend" }],
    });
  });

  it("reports the failure reason instead of falling back to the in-process store", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    for (const reason of ["unreachable", "timeout", "unauthorized", "incompatible", "bad-response"]) {
      mocks.readBackendTasks.mockResolvedValue({ ok: false, reason });
      const response = await GET(request());
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Backendから取得できませんでした",
        reason,
      });
    }
  });

  it("tolerates a Backend payload without a task list", async () => {
    mocks.webUiAuthRequired.mockReturnValue(false);
    mocks.backendClientStatus.mockReturnValue({ configured: true, url: "http://127.0.0.1:18776" });
    mocks.readBackendTasks.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect((await GET(request())).json()).resolves.toEqual({ source: "backend", tasks: [] });
  });

  it("keeps the relay behind the WebUI auth gate when it is required", async () => {
    mocks.webUiAuthRequired.mockReturnValue(true);
    mocks.isWebUiRequestAuthorized.mockReturnValue(false);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.backendClientStatus).not.toHaveBeenCalled();
  });
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostControl = vi.hoisted(() => ({
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18775"),
}));

vi.mock("@/lib/host-control", () => hostControl);

import { GET } from "./route";
import { POST } from "./[action]/route";

function request(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/chatgpt-bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hostControl.resolveHostControlUrl.mockReturnValue("http://127.0.0.1:18775");
  });

  it("forwards a safe status query and disables caching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, state: "ready", projectId: "project-1" }), { status: 200 }),
    );

    const response = await GET(request("http://127.0.0.1:3010/api/chatgpt-bridge?projectId=project-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, state: "ready", projectId: "project-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/chatgpt-bridge/status?projectId=project-1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects unsafe project ids before contacting Host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await POST(
      request("http://127.0.0.1:3010/api/chatgpt-bridge/start", { projectId: "../secret" }),
      { params: Promise.resolve({ action: "start" }) },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the supported disconnect fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, state: "ready" }), { status: 200 }),
    );

    const response = await POST(
      request("http://127.0.0.1:3010/api/chatgpt-bridge/disconnect", {
        projectId: "project-1",
        deleteState: true,
      }),
      { params: Promise.resolve({ action: "disconnect" }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/chatgpt-bridge/disconnect",
      expect.objectContaining({ body: JSON.stringify({ projectId: "project-1", deleteState: true }) }),
    );
  });
});

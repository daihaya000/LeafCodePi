import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostControl = vi.hoisted(() => ({
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18775"),
}));

vi.mock("@/lib/host-control", () => hostControl);

import { GET } from "./route";
import { PATCH, POST } from "./[action]/route";

function request(url: string, body?: unknown, method = "POST"): NextRequest {
  return new NextRequest(url, body === undefined ? undefined : {
    method,
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

  it("accepts PATCH for an allowlisted conversation URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, conversationUrl: "https://chatgpt.com/c/demo" }), { status: 200 }),
    );
    const response = await PATCH(
      request("http://127.0.0.1:3010/api/chatgpt-bridge/session", {
        projectId: "project-1",
        conversationUrl: "https://chatgpt.com/c/demo",
      }, "PATCH"),
      { params: Promise.resolve({ action: "session" }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/chatgpt-bridge/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: "project-1", conversationUrl: "https://chatgpt.com/c/demo" }),
      }),
    );
  });

  it("forwards advisory messages with a public task id only", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: "[C2C]" }), { status: 200 }),
    );
    const response = await POST(
      request("http://127.0.0.1:3010/api/chatgpt-bridge/message", {
        projectId: "project-1",
        publicTaskId: "c2c_task",
        iteration: 2,
        kind: "init",
        goal: "レビュー",
      }),
      { params: Promise.resolve({ action: "message" }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/chatgpt-bridge/message",
      expect.objectContaining({
        body: JSON.stringify({
          projectId: "project-1",
          publicTaskId: "c2c_task",
          iteration: 2,
          kind: "init",
          goal: "レビュー",
        }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain("internal-task");
  });
});

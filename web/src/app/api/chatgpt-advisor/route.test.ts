import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn();

vi.mock("@/lib/host-control", () => ({
  resolveHostControlUrl: () => "http://127.0.0.1:39123",
}));

vi.stubGlobal("fetch", fetchMock);

import { GET } from "@/app/api/chatgpt-advisor/route";
import { POST } from "@/app/api/chatgpt-advisor/[action]/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeGetReq(url: string): NextRequest {
  return new NextRequest(url, { headers: { host: "127.0.0.1" } });
}

function makePostReq(url: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = { host: "127.0.0.1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("chatgpt-advisor BFF", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("GET status forwards projectId and returns host body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, state: "ready", enabled: true }));
    const res = await GET(makeGetReq("http://localhost/api/chatgpt-advisor?projectId=p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ready");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:39123/chatgpt-advisor/status?projectId=p1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  test("GET rejects invalid projectId", async () => {
    const res = await GET(makeGetReq("http://localhost/api/chatgpt-advisor?projectId=bad id!"));
    expect(res.status).toBe(400);
  });

  test("POST setup forwards projectId to host", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ready: true }));
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/setup", { projectId: "p1" }),
      { params: Promise.resolve({ action: "setup" }) },
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:39123/chatgpt-advisor/setup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: "p1" }),
      }),
    );
  });

  test("POST unknown action returns 404", async () => {
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/bogus", {}),
      { params: Promise.resolve({ action: "bogus" }) },
    );
    expect(res.status).toBe(404);
  });

  test("POST enabled requires boolean", async () => {
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/enabled", { enabled: "yes" }),
      { params: Promise.resolve({ action: "enabled" }) },
    );
    expect(res.status).toBe(400);
  });

  test("POST setup requires projectId", async () => {
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/setup", {}),
      { params: Promise.resolve({ action: "setup" }) },
    );
    expect(res.status).toBe(400);
  });

  test("POST stop forwards empty body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, state: "stopped" }));
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/stop", {}),
      { params: Promise.resolve({ action: "stop" }) },
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:39123/chatgpt-advisor/stop",
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  test("POST cleanup rejects non-boolean deleteProfile", async () => {
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/cleanup", { deleteProfile: "yes" }),
      { params: Promise.resolve({ action: "cleanup" }) },
    );
    expect(res.status).toBe(400);
  });

  test("POST returns 503 when host unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await POST(
      makePostReq("http://localhost/api/chatgpt-advisor/verify", {}),
      { params: Promise.resolve({ action: "verify" }) },
    );
    expect(res.status).toBe(503);
  });
});

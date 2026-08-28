import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostControl = vi.hoisted(() => ({
  hostWebUiAuthPath: vi.fn(() => "/webui/auth"),
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18775"),
}));

vi.mock("@/lib/host-control", () => hostControl);

import { GET, POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/host/webui-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/host/webui-auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards safe status and sets the new token cookie without returning the token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        accepted: true,
        enabled: false,
        remote: true,
        authRequired: false,
        tokenConfigured: true,
      }), { status: 202 }),
    );

    const response = await POST(request({ enabled: false, token: "user-token-1234567890" }));

    expect(response.status).toBe(202);
    expect((await response.json()).token).toBeUndefined();
    expect(response.headers.get("set-cookie")).toContain("leafcode-pi-token=user-token-1234567890");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/webui/auth",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "user-token-1234567890", enabled: false }),
      }),
    );
  });

  it("returns the host status on GET", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, remote: false, authRequired: false }), { status: 200 }),
    );

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, remote: false, authRequired: false });
  });

  it("rejects patches without supported fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await POST(request({ unknown: true }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

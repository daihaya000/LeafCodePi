import { beforeEach, describe, expect, it, vi } from "vitest";

const hostControl = vi.hoisted(() => ({
  hostPiUpdatePath: vi.fn(() => "/pi/update"),
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18775"),
}));

vi.mock("@/lib/host-control", () => hostControl);

import { GET, POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://127.0.0.1:3010/api/pi/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/pi/update", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the host status on GET", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, defaultVersion: "1.0.0", current: "0.99.2" }), {
        status: 200,
      }),
    );

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, defaultVersion: "1.0.0", current: "0.99.2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/pi/update",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("forwards reservations and rejects unsupported modes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, accepted: true, pending: { mode: "latest", requestedAt: 1 } }),
        { status: 202 },
      ),
    );

    const response = await POST(request({ mode: "latest" }));

    expect(response.status).toBe(202);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ mode: "latest" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:18775/pi/update");

    const invalid = await POST(request({ mode: "nightly" }));
    expect(invalid.status).toBe(400);
  });

  it("maps an unreachable host to 502 with a launch hint", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));

    const response = await GET();

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; hint?: string };
    expect(body.error).toContain("接続できません");
    expect(body.hint).toBeTruthy();
  });

  it("maps an older host without the route to 501", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 }),
    );

    const response = await GET();

    expect(response.status).toBe(501);
    expect(((await response.json()) as { error: string }).error).toContain("ホストを再起動");
  });
});

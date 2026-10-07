import { beforeEach, describe, expect, it, vi } from "vitest";

const hostControl = vi.hoisted(() => ({
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18775"),
  hostRestartPath: vi.fn((target: string) =>
    target === "host" ? "/restart/host" : target === "backend" ? "/restart/backend" : "/restart/webui",
  ),
}));

vi.mock("@/lib/host-control", () => hostControl);
vi.mock("@/lib/host-launch-hints", () => ({
  hostLaunchCheckHint: () => "hint",
}));

import { POST } from "./route";

describe("POST /api/host/restart", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hostControl.resolveHostControlUrl.mockReturnValue("http://127.0.0.1:18775");
    hostControl.hostRestartPath.mockImplementation((target: string) =>
      target === "host" ? "/restart/host" : target === "backend" ? "/restart/backend" : "/restart/webui",
    );
  });

  it("preserves Goal Loop 409 refusals instead of remapping them to 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          target: "backend",
          blocked: true,
          error: "Goal Loop が 1 件実行中のため Backend の再起動を拒否しました。",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await POST(
      new Request("http://localhost/api/host/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "backend" }),
      }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Goal Loop が 1 件実行中のため Backend の再起動を拒否しました。",
      target: "backend",
      blocked: true,
    });
  });

  it("passes the measured host estimate to the browser", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true, target: "host", accepted: true, estimateMs: 99_000, estimateSamples: 4,
    }), { status: 202 }));
    const res = await POST(new Request("http://localhost/api/host/restart", {
      method: "POST", body: JSON.stringify({ target: "host" }),
    }));
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ estimateMs: 99_000, estimateSamples: 4 });
  });

  it("still maps unexpected host failures to 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST(
      new Request("http://localhost/api/host/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "webui" }),
      }),
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "boom", target: "webui" });
  });
});

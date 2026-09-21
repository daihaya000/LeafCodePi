import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getCacheWarmingMode: vi.fn(),
  setCacheWarmingMode: vi.fn(),
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  }),
}));

vi.mock("@/lib/pi/harness", () => harness);

import { GET, PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/cache-warming", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/cache-warming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getCacheWarmingMode.mockResolvedValue("streaming");
    harness.setCacheWarmingMode.mockImplementation(async (mode: string) => mode);
  });

  it("returns and updates the cache-warming mode", async () => {
    expect(await (await GET()).json()).toEqual({ mode: "streaming" });

    const response = await PATCH(request({ mode: "idle" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "idle" });
    expect(harness.setCacheWarmingMode).toHaveBeenCalledWith("idle");
  });

  it("rejects unsupported modes", async () => {
    const response = await PATCH(request({ mode: "always" }));

    expect(response.status).toBe(400);
    expect(harness.setCacheWarmingMode).not.toHaveBeenCalled();
  });
});

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getHealth: vi.fn(), jsonError: vi.fn() }));
vi.mock("@/lib/pi/harness", () => ({ getHealth: mocks.getHealth, jsonError: mocks.jsonError }));

import { GET } from "./route";

const health = {
  ok: true,
  engine: "pi",
  engineOk: true,
  version: "1.0.0",
  modelCount: 3,
  dataDir: "C:\\Users\\secret\\leafcode-pi",
  warnings: ["provider sync failed"],
};

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1:3010/api/health", { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.getHealth.mockReset();
});

describe("GET /api/health", () => {
  it("returns the full payload when auth is not required", async () => {
    mocks.getHealth.mockResolvedValue(health);
    const body = await (await GET(request())).json();
    expect(body.dataDir).toBe(health.dataDir);
    expect(body.warnings).toEqual(health.warnings);
  });

  it("hides dataDir and warnings from unauthenticated remote callers", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "secret-token");
    mocks.getHealth.mockResolvedValue(health);

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    // The host's readiness probe only reads `ok`.
    expect(body.ok).toBe(true);
    expect(body.version).toBe("1.0.0");
    expect(body).not.toHaveProperty("dataDir");
    expect(body).not.toHaveProperty("warnings");
  });

  it("returns the full payload to a caller with the token", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "secret-token");
    mocks.getHealth.mockResolvedValue(health);

    const body = await (
      await GET(request({ cookie: "leafcode-pi-token=secret-token" }))
    ).json();
    expect(body.dataDir).toBe(health.dataDir);

    const bearer = await (
      await GET(request({ authorization: "Bearer secret-token" }))
    ).json();
    expect(bearer.dataDir).toBe(health.dataDir);
  });
});

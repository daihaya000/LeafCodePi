import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

const token = "test-webui-token";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3010${path}`, {
    headers: cookie ? { cookie: `leafcode-pi-token=${cookie}` } : {},
  });
}

describe("WebUI device authentication", () => {
  beforeEach(() => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", token);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps a recognized browser signed in and renews its persistent cookie", () => {
    const response = proxy(request("/settings", token));
    expect(response.status).toBe(200);
    expect(response.cookies.get("leafcode-pi-token")?.value).toBe(token);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=31536000");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("skips the login form for a recognized browser", () => {
    const response = proxy(request("/login?next=%2Fsettings", token));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3010/settings");
    expect(response.cookies.get("leafcode-pi-token")?.value).toBe(token);
  });

  it("does not follow an external or recursive login destination", () => {
    expect(proxy(request("/login?next=%2F%2Fevil.example", token)).headers.get("location"))
      .toBe("http://localhost:3010/");
    expect(proxy(request("/login?next=%2Flogin", token)).headers.get("location"))
      .toBe("http://localhost:3010/");
  });

  it("requires the new token after a rotation and does not renew the stale cookie", () => {
    const response = proxy(request("/settings", "old-token"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login?next=%2Fsettings");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("continues to require authentication for a new browser", () => {
    const response = proxy(request("/api/tasks"));
    expect(response.status).toBe(401);
  });
});

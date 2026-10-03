import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLoginLimiterForTests } from "@/lib/webui-login-limit";
import { POST } from "./route";

const login = (token: string, ip = "203.0.113.5") =>
  POST(new Request("http://localhost/api/auth/webui", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ token }),
  }));

describe("POST /api/auth/webui rate limit", () => {
  const saved = { auth: process.env.LEAFCODE_PI_WEBUI_AUTH, token: process.env.LEAFCODE_PI_WEBUI_TOKEN };
  beforeEach(() => {
    process.env.LEAFCODE_PI_WEBUI_AUTH = "required";
    process.env.LEAFCODE_PI_WEBUI_TOKEN = "correct-token";
    resetLoginLimiterForTests();
  });
  afterEach(() => {
    for (const [key, value] of [["LEAFCODE_PI_WEBUI_AUTH", saved.auth], ["LEAFCODE_PI_WEBUI_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLoginLimiterForTests();
  });

  it("blocks a client after repeated failures, even with the right token, but not other clients", async () => {
    for (let i = 0; i < 10; i += 1) expect((await login("wrong")).status).toBe(401);
    const blocked = await login("correct-token");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login("correct-token", "198.51.100.7")).status).toBe(200);
  });

  it("resets the counter after a successful login", async () => {
    for (let i = 0; i < 9; i += 1) await login("wrong");
    expect((await login("correct-token")).status).toBe(200);
    for (let i = 0; i < 9; i += 1) expect((await login("wrong")).status).toBe(401);
  });
});

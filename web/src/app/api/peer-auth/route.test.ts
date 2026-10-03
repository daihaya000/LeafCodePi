import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/peer-auth/runtime", () => ({ peerAuthService: () => mocks }));

import { GET as listRoute } from "./list/route";
import { POST as resolveRoute } from "./resolve/route";
import { POST as usageRoute } from "./usage/route";

const ok = { status: 200, body: { ok: true }, headers: { "Cache-Control": "no-store" } };

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("http://lcp.test/api/peer-auth/resolve", { method: "POST", body, headers });
}

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue(ok);
  mocks.resolve.mockReset().mockResolvedValue(ok);
  mocks.usage.mockReset().mockResolvedValue(ok);
});

describe("GET /api/peer-auth/list", () => {
  it("passes the authorization header to the service and relays status and headers", async () => {
    mocks.list.mockResolvedValue({ status: 429, body: { error: "rate-limited" }, headers: { "Cache-Control": "no-store", "Retry-After": "7" } });
    const response = await listRoute(new Request("http://lcp.test/api/peer-auth/list", { headers: { authorization: "Bearer tok" } }));
    expect(mocks.list).toHaveBeenCalledWith({ authorization: "Bearer tok" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "rate-limited" });
  });

  it("passes a null authorization when the header is absent", async () => {
    await listRoute(new Request("http://lcp.test/api/peer-auth/list"));
    expect(mocks.list).toHaveBeenCalledWith({ authorization: null });
  });
});

describe("POST /api/peer-auth/usage", () => {
  it("passes the scoped account body and bearer header to the service", async () => {
    const response = await usageRoute(post('{"accountId":"acc1"}', { authorization: "Bearer tok" }));
    expect(mocks.usage).toHaveBeenCalledWith({ authorization: "Bearer tok", body: { accountId: "acc1" } });
    expect(response.status).toBe(200);
  });
});

describe("POST /api/peer-auth/resolve", () => {
  it("parses the JSON body and forwards it with the authorization header", async () => {
    const response = await resolveRoute(post('{"providerId":"anthropic"}', { authorization: "Bearer tok" }));
    expect(mocks.resolve).toHaveBeenCalledWith({ authorization: "Bearer tok", body: { providerId: "anthropic" } });
    expect(response.status).toBe(200);
  });

  it.each([
    ["malformed", "{nope"],
    ["empty", ""],
    ["oversize", JSON.stringify({ providerId: "a".repeat(5000) })],
  ])("hands a %s body to the service as null so authentication still decides first", async (_name, body) => {
    await resolveRoute(post(body, { authorization: "Bearer tok" }));
    expect(mocks.resolve).toHaveBeenCalledWith({ authorization: "Bearer tok", body: null });
  });

  it("rejects a declared oversize body without reading it", async () => {
    await resolveRoute(post('{"providerId":"a"}', { "content-length": "999999" }));
    expect(mocks.resolve).toHaveBeenCalledWith({ authorization: null, body: null });
  });
});

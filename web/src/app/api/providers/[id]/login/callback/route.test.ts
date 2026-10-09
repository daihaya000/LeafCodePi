import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeProviderLoginCallback: vi.fn(),
  jsonError: (error: unknown) => ({ error: (error as Error).message, status: (error as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/pi/harness", () => mocks);
import { POST } from "@backend-runtime/json-business/handlers/providers/[id]/login/callback/route";

const input = "http://127.0.0.1:1456/oauth/callback?code=test-code&state=test-state";
const context = { params: Promise.resolve({ id: "radius" }) };
function request(body: unknown) {
  return new Request("http://localhost/api/providers/radius/login/callback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => { mocks.completeProviderLoginCallback.mockReset(); });

describe("POST provider login callback", () => {
  it("binds the pasted callback to the provider and login session", async () => {
    const response = await POST(request({ sessionId: "session-1", input }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.completeProviderLoginCallback).toHaveBeenCalledWith("radius", "session-1", input);
  });

  it.each([null, [], {}, { input }, { sessionId: " " , input }, { sessionId: "session-1", input: 1 }, { sessionId: "session-1", input: "x".repeat(16385) }])("rejects malformed request %#", async (body) => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(mocks.completeProviderLoginCallback).not.toHaveBeenCalled();
  });

  it("rejects stale sessions without claiming login success", async () => {
    mocks.completeProviderLoginCallback.mockRejectedValue(Object.assign(new Error("Session mismatch"), { status: 409 }));
    const response = await POST(request({ sessionId: "stale", input }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "認証操作に失敗しました" });
  });
});

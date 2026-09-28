import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), save: vi.fn(), notify: vi.fn(), guard: vi.fn(),
}));
vi.mock("@/lib/pushover-config", () => ({
  getPushoverSettingsDto: mocks.get,
  savePushoverSettings: mocks.save,
  PushoverEnvManagedError: class PushoverEnvManagedError extends Error {},
}));
vi.mock("@/lib/pushover", () => ({ notifyPushoverCompletion: mocks.notify }));
vi.mock("@/lib/pi/transfer-access", () => ({
  rejectUnauthorizedTransfer: mocks.guard,
  transferNoStore: { "Cache-Control": "no-store, private" },
}));

import { PushoverEnvManagedError } from "@/lib/pushover-config";
import { GET, POST, PUT } from "./route";

const dto = {
  hasToken: true, hasUser: true, device: "iphone",
  envManaged: { token: false, user: false, device: false },
};
const request = (body: unknown) => new NextRequest("http://localhost/api/pushover", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const read = () => new NextRequest("http://localhost/api/pushover");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.get.mockResolvedValue(dto);
  mocks.save.mockResolvedValue(undefined);
  mocks.notify.mockResolvedValue(true);
});

describe("Pushover settings API", () => {
  it("returns presence but never stored credentials and disables HTTP caching", async () => {
    const response = await GET(read());
    expect(await response.json()).toEqual(dto);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("saves validated values, trims them and never echoes them", async () => {
    const response = await PUT(request({ token: " abc123 ", user: " xyz789 ", device: " iphone " }));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ token: "abc123", user: "xyz789", device: "iphone" });
    expect(await response.text()).not.toContain("abc123");
    expect((await PUT(request({ token: null, device: "" }))).status).toBe(200);
    expect(mocks.save).toHaveBeenLastCalledWith({ token: null, device: null });
  });

  it.each([
    {}, { token: 123 }, { token: "invalid\nkey" }, { user: "" },
    { token: "x".repeat(129) }, { device: "x".repeat(101) }, { device: "line\nbreak" },
    { unknown: "value" }, null,
  ])("rejects malformed input without storage writes", async (body) => {
    expect((await PUT(request(body))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects unauthorized requests before parsing submitted secrets", async () => {
    mocks.guard.mockReturnValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await PUT(request({ token: "secret" }))).status).toBe(403);
    expect((await GET(read())).status).toBe(403);
    expect((await POST(read())).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests even when Origin is omitted", async () => {
    const crossSite = new NextRequest("http://localhost/api/pushover", {
      method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ token: "secret" }),
    });
    expect((await PUT(crossSite)).status).toBe(403);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not reflect secrets from storage failures or JSON parse errors", async () => {
    mocks.save.mockRejectedValue(new Error("secret-leak"));
    const response = await PUT(request({ token: "secretleak" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
    const malformed = new NextRequest("http://localhost/api/pushover", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "secret-leak{",
    });
    expect(await (await PUT(malformed)).text()).not.toContain("secret-leak");
  });

  it("reports environment-owned fields as read-only", async () => {
    mocks.save.mockRejectedValue(new PushoverEnvManagedError("環境変数で管理されている項目は変更できません"));
    expect((await PUT(request({ token: "abc123" }))).status).toBe(409);
  });

  it("sends a test message only when both keys are present", async () => {
    expect((await POST(read())).status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledWith("iPhoneへの通知を確認", { title: "テスト通知" });
    mocks.get.mockResolvedValue({ ...dto, hasUser: false });
    expect((await POST(read())).status).toBe(400);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValue(dto);
    mocks.notify.mockResolvedValue(false);
    expect((await POST(read())).status).toBe(502);
  });
});

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/pushover-config", () => ({
  readPushoverNotificationEnabled: mocks.read,
  savePushoverNotificationEnabled: mocks.save,
}));
vi.mock("@/lib/pi/transfer-access", () => ({
  rejectUnauthorizedTransfer: mocks.guard,
  transferNoStore: { "Cache-Control": "no-store, private" },
}));

import { GET, PUT } from "@backend-runtime/configuration/handlers/notifications/route";

const getRequest = () => new NextRequest("http://localhost/api/notifications");
const putRequest = (body: unknown) => new NextRequest("http://localhost/api/notifications", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.read.mockReturnValue(true);
});

describe("shared notification delivery API", () => {
  it("reads and persists the gate without opening Pushover credential storage", async () => {
    const current = await GET(getRequest());
    expect(await current.json()).toEqual({ enabled: true });
    expect(current.headers.get("Cache-Control")).toBe("no-store, private");
    mocks.read.mockReturnValue(false);
    const changed = await PUT(putRequest({ enabled: false }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ enabled: false });
    expect(mocks.save).toHaveBeenCalledWith(false);
  });

  it.each([null, {}, { enabled: null }, { enabled: "false" }, { enabled: false, extra: true }])(
    "rejects invalid delivery payloads", async (body) => {
      expect((await PUT(putRequest(body))).status).toBe(400);
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it("blocks unauthenticated and cross-site requests before writing", async () => {
    mocks.guard.mockReturnValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await GET(getRequest())).status).toBe(403);
    expect((await PUT(putRequest({ enabled: false }))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.guard.mockClear().mockReturnValue(null);
    const crossSite = new NextRequest("http://localhost/api/notifications", {
      method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await PUT(crossSite)).status).toBe(403);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not leak storage failures", async () => {
    mocks.save.mockImplementation(() => { throw new Error("private path"); });
    const response = await PUT(putRequest({ enabled: false }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private path");
  });
});

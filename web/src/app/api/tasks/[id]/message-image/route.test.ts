import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
  jsonError: vi.fn(() => ({ error: "failed", status: 500 })),
}));
vi.mock("@/lib/pi/harness", () => ({ getTaskDetail: mocks.getTaskDetail, jsonError: mocks.jsonError }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskDetail: mocks.forwardTaskDetail }));
vi.mock("@/lib/task-history", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/task-history")>(),
}));

import { GET } from "./route";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const imageMessage = {
  id: "u1",
  role: "user",
  createdAt: 1,
  parts: [
    { id: "u1:image", type: "image", mime: "image/png", url: `data:image/png;base64,${PNG_BASE64}` },
    { id: "u1:text", type: "text", text: "not an image" },
  ],
};

function request(query: string) {
  return new NextRequest(`http://localhost/api/tasks/task-1/message-image${query}`);
}

const params = { params: Promise.resolve({ id: "task-1" }) };

beforeEach(() => {
  mocks.getTaskDetail.mockReset();
  mocks.jsonError.mockClear();
  mocks.localRuntimeBlocked.mockReset();
  mocks.localRuntimeBlocked.mockReturnValue(false);
  mocks.forwardTaskDetail.mockReset();
  mocks.getTaskDetail.mockResolvedValue({ messages: [imageMessage] });
});

describe("/api/tasks/[id]/message-image", () => {
  it("serves the requested image part as bytes", async () => {
    const response = await GET(request("?messageId=u1&partId=u1%3Aimage"), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes).toString("base64")).toBe(PNG_BASE64);
  });

  it("rejects missing or oversized parameters before reading the transcript", async () => {
    expect((await GET(request(""), params)).status).toBe(400);
    expect((await GET(request(`?messageId=u1&partId=${"x".repeat(600)}`), params)).status).toBe(400);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("reports an unknown message or part as 404", async () => {
    expect((await GET(request("?messageId=nope&partId=u1%3Aimage"), params)).status).toBe(404);
    expect((await GET(request("?messageId=u1&partId=u1%3Atext"), params)).status).toBe(404);
  });

  it("does not serve a part whose data was already stripped", async () => {
    mocks.getTaskDetail.mockResolvedValue({
      messages: [{ ...imageMessage, parts: [{ ...imageMessage.parts[0], url: "" }] }],
    });
    expect((await GET(request("?messageId=u1&partId=u1%3Aimage"), params)).status).toBe(404);
  });

  it("refuses a non-image data URL", async () => {
    mocks.getTaskDetail.mockResolvedValue({
      messages: [{ ...imageMessage, parts: [{ ...imageMessage.parts[0], url: "data:text/plain;base64,aGk=" }] }],
    });
    expect((await GET(request("?messageId=u1&partId=u1%3Aimage"), params)).status).toBe(415);
  });
});

describe("/api/tasks/[id]/message-image after the cutover", () => {
  beforeEach(() => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
  });

  it("serves the part from the owning Backend without opening the transcript locally", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { messages: [imageMessage] } });

    const response = await GET(request("?messageId=u1&partId=u1%3Aimage"), params);

    expect(response.status).toBe(200);
    expect(Buffer.from(new Uint8Array(await response.arrayBuffer())).toString("base64")).toBe(PNG_BASE64);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1");
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("reports a missing part or an empty Backend detail as 404", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { messages: [imageMessage] } });
    expect((await GET(request("?messageId=u1&partId=u1%3Atext"), params)).status).toBe(404);

    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: null });
    expect((await GET(request("?messageId=u1&partId=u1%3Aimage"), params)).status).toBe(404);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("does not fall back locally when the Backend cannot answer", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    expect((await GET(request("?messageId=u1&partId=u1%3Aimage"), params)).status).toBe(404);

    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "not-configured" });
    const unconfigured = await GET(request("?messageId=u1&partId=u1%3Aimage"), params);
    expect(unconfigured.status).toBe(409);
    await expect(unconfigured.json()).resolves.toMatchObject({ code: "RUNTIME_NOT_OWNED" });

    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await GET(request("?messageId=u1&partId=u1%3Aimage"), params);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({ code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("rejects bad parameters before contacting the Backend", async () => {
    expect((await GET(request(""), params)).status).toBe(400);
    expect(mocks.forwardTaskDetail).not.toHaveBeenCalled();
  });
});

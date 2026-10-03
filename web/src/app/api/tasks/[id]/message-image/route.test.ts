import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getTaskDetail: vi.fn(), jsonError: vi.fn(() => ({ error: "failed", status: 500 })) }));
vi.mock("@/lib/pi/harness", () => ({ getTaskDetail: mocks.getTaskDetail, jsonError: mocks.jsonError }));
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

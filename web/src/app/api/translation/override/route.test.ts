import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveHostControlUrl } = vi.hoisted(() => ({
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18765"),
}));

vi.mock("@/lib/host-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host-control")>();
  return { ...actual, resolveHostControlUrl };
});

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://127.0.0.1:3000/api/translation/override", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/translation/override", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveHostControlUrl.mockReturnValue("http://127.0.0.1:18765");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("validates the correction before contacting the host", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request({ text: "source", translation: "  " }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a valid correction to the local host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        text: "Reviewing cache behavior",
        translation: "キャッシュ動作をレビュー中",
      }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request({
      text: "Reviewing cache behavior",
      translation: "キャッシュ動作をレビュー中",
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18765/translation/override",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      translation: "キャッシュ動作をレビュー中",
    });
  });
});

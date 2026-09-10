import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/host-control", () => ({
  hostTranslationPath: (action: string) => `/translation/${action}`,
  resolveHostControlUrl: () => "http://127.0.0.1:18775",
}));

import { POST as reasoningPost } from "./reasoning/route";
import { POST as overridePost } from "./override/route";
import { GET as statusGet } from "./status/route";
import { POST as installPost } from "./install/route";

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/translation/reasoning", () => {
  it("rejects invalid text lists", async () => {
    for (const body of [
      {},
      { texts: [] },
      { texts: Array.from({ length: 17 }, () => "x") },
      { texts: [""] },
      { texts: [123] },
      { texts: ["x".repeat(16_001)] },
    ]) {
      vi.stubGlobal("fetch", vi.fn());
      const response = await reasoningPost(jsonRequest("http://localhost/api/translation/reasoning", body));
      expect(response.status).toBe(400);
    }
  });

  it("forwards valid texts and returns the host payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { translations: ["訳:hello"] }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await reasoningPost(
      jsonRequest("http://localhost/api/translation/reasoning", { texts: ["hello"] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translations: ["訳:hello"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/translation/translate",
      expect.objectContaining({ method: "POST", signal: expect.anything() }),
    );
  });

  it("maps host errors to 502 and connectivity failures to 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })),
    );
    const failed = await reasoningPost(
      jsonRequest("http://localhost/api/translation/reasoning", { texts: ["hi"] }),
    );
    expect(failed.status).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );
    const unreachable = await reasoningPost(
      jsonRequest("http://localhost/api/translation/reasoning", { texts: ["hi"] }),
    );
    expect(unreachable.status).toBe(503);
  });
});

describe("POST /api/translation/override", () => {
  it("rejects missing, empty, or oversized fields", async () => {
    for (const body of [
      {},
      { text: "", translation: "x" },
      { text: "x", translation: " " },
      { text: "x".repeat(16_001), translation: "y" },
      { text: "x", translation: "y".repeat(16_001) },
    ]) {
      const response = await overridePost(
        jsonRequest("http://localhost/api/translation/override", body),
      );
      expect(response.status).toBe(400);
    }
  });

  it("forwards the correction to the host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await overridePost(
      jsonRequest("http://localhost/api/translation/override", {
        text: "hello",
        translation: "こんにちは",
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/translation/override",
      expect.objectContaining({
        body: JSON.stringify({ text: "hello", translation: "こんにちは" }),
      }),
    );
  });

  it("carries host 4xx status through and maps 5xx to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(422, { error: "invalid" })),
    );
    const clientError = await overridePost(
      jsonRequest("http://localhost/api/translation/override", {
        text: "x",
        translation: "y",
      }),
    );
    expect(clientError.status).toBe(422);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })),
    );
    const serverError = await overridePost(
      jsonRequest("http://localhost/api/translation/override", {
        text: "x",
        translation: "y",
      }),
    );
    expect(serverError.status).toBe(502);
  });
});

describe("GET /api/translation/status", () => {
  it("forwards a healthy host response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })),
    );
    const response = await statusGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("reports host-outdated on 404 from the host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, {})),
    );
    const response = await statusGet();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, state: "host-outdated" });
  });

  it("reports unavailable when the host is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );
    const response = await statusGet();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, state: "unavailable" });
  });
});

describe("POST /api/translation/install", () => {
  it("returns 202 and forwards the host payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { installState: "installing" }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await installPost();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ installState: "installing" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18775/translation/install",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps host failures and connectivity errors to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })),
    );
    expect((await installPost()).status).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("refused")),
    );
    expect((await installPost()).status).toBe(502);
  });
});
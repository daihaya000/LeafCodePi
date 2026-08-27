import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const undici = vi.hoisted(() => ({
  Agent: vi.fn().mockImplementation(() => ({})),
  fetch: vi.fn(),
}));

vi.mock("undici", () => undici);

import { fetchText } from "./utils";

beforeEach(() => {
  undici.fetch.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("fetchText", () => {
  it("retries connect timeouts with a longer-lived undici connection", async () => {
    const error = Object.assign(new Error("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    undici.fetch.mockResolvedValue(new Response("fallback", { status: 200 }));

    await expect(fetchText("https://example.test", { timeoutMs: 1_000 })).resolves.toEqual({
      status: 200,
      body: "fallback",
      ok: true,
    });

    expect(undici.fetch).toHaveBeenCalledWith(
      "https://example.test",
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });

  it("does not retry non-connect errors", async () => {
    const error = new Error("DNS failure");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(fetchText("https://example.test")).rejects.toBe(error);
    expect(undici.fetch).not.toHaveBeenCalled();
  });
});

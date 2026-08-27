import { beforeEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());
const dns = vi.hoisted(() => ({
  lookup: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    lookup: dns.lookup,
    promises: { ...actual.promises, resolve4: dns.resolve4, resolve6: dns.resolve6 },
  };
});

import { fetchText, racingLookup } from "./utils";

/** Promise wrapper over the node-style lookup callback. */
function lookupAll(hostname: string, options: Record<string, unknown> = { all: true }) {
  return new Promise<unknown>((resolve, reject) => {
    racingLookup(hostname, options, (err, address, family) =>
      err ? reject(err) : resolve(family === undefined ? address : { address, family }),
    );
  });
}

beforeEach(() => {
  undiciFetch.mockReset();
  dns.lookup.mockReset();
  dns.resolve4.mockReset();
  dns.resolve6.mockReset();
});

describe("fetchText", () => {
  it("sends every request through the shared dispatcher", async () => {
    undiciFetch.mockResolvedValue(new Response("payload", { status: 201 }));

    await expect(fetchText("https://example.test")).resolves.toEqual({
      status: 201,
      body: "payload",
      ok: true,
    });
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://example.test",
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });

  it("propagates transport failures", async () => {
    const error = new Error("fetch failed");
    undiciFetch.mockRejectedValue(error);

    await expect(fetchText("https://example.test")).rejects.toBe(error);
  });
});

describe("racingLookup", () => {
  it("uses the direct DNS answer when the OS resolver stalls", async () => {
    dns.lookup.mockImplementation(() => {
      /* never calls back: mimics a 12s getaddrinfo stall */
    });
    dns.resolve6.mockRejectedValue(new Error("no AAAA"));
    dns.resolve4.mockResolvedValue(["160.79.104.10"]);

    await expect(lookupAll("api.example.test")).resolves.toEqual([
      { address: "160.79.104.10", family: 4 },
    ]);
  });

  it("keeps the OS answer for names plain DNS cannot resolve", async () => {
    dns.lookup.mockImplementation(
      (_host: string, _opts: unknown, cb: (e: null, a: unknown) => void) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }]),
    );
    dns.resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    dns.resolve6.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(lookupAll("localhost", {})).resolves.toEqual({
      address: "127.0.0.1",
      family: 4,
    });
  });

  it("reports an error only after both resolvers fail", async () => {
    dns.lookup.mockImplementation(
      (_host: string, _opts: unknown, cb: (e: Error) => void) =>
        cb(new Error("getaddrinfo ENOTFOUND")),
    );
    dns.resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    dns.resolve6.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(lookupAll("missing.example.test")).rejects.toThrow(/ENOTFOUND|no records/);
  });
});

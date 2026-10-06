import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const packageUrls = [
  "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest",
  "https://registry.npmjs.org/@earendil-works%2fpi-ai/latest",
];

describe("/api/pi/latest-version", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the matching latest stable version of both Pi packages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: "1.2.3", checkedAt: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(packageUrls);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ cache: "no-store", headers: { accept: "application/json" } }),
    );
  });

  it("rejects packages whose latest versions do not match", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "1.2.4" }), { status: 200 }));

    const response = await GET();

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("一致しません");
  });

  it("returns an error when the npm registry is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));

    const response = await GET();

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("HTTP 503");
  });
});

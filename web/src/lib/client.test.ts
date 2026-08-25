import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("getJson", () => {
  it("coalesces simultaneous GETs and removes the request after completion", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });

    let resolveFetch!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    const json = vi.fn().mockResolvedValue({ value: 1 });
    const fetchMock = vi.fn(
      () => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = getJson<{ value: number }>("/api/models");
    const second = getJson<{ value: number }>("/api/models");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json });
    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 1 }, { value: 1 }]);
    expect(json).toHaveBeenCalledTimes(1);

    const third = getJson<{ value: number }>("/api/models");
    resolveFetch({ ok: true, json });
    await expect(third).resolves.toEqual({ value: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasJevNoulJudge,
  JEV_NOUL_JUDGE_KEY,
  requestJevNoul,
  type JevNoulJudge,
  type JevNoulRequest,
} from "./jev-bridge.ts";

type BridgeHost = typeof globalThis & { [JEV_NOUL_JUDGE_KEY]?: JevNoulJudge | null };

const host = globalThis as BridgeHost;
const request = {
  state: { userRequest: "説明して" },
  questions: {
    big: { instructions: "Is this a big task?" },
    vague: {
      instructions: "Is this a vague follow-up?",
      criteria: { true: "Vague.", false: "Specific." },
    },
  },
};
const never = () => new Promise<Record<string, number> | null>(() => undefined);
const answer = (big: unknown, vague: unknown) => async () => ({ big, vague }) as never;

afterEach(() => {
  delete host[JEV_NOUL_JUDGE_KEY];
  vi.useRealTimers();
});

describe("requestJevNoul", () => {
  it("is null when no host published a judge", async () => {
    expect(hasJevNoulJudge()).toBe(false);
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
  });

  it("ignores a slot that is not a function", async () => {
    host[JEV_NOUL_JUDGE_KEY] = "judge" as never;
    expect(hasJevNoulJudge()).toBe(false);
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
  });

  it("returns every probability and hands the request plus a signal to the judge", async () => {
    const judge = vi.fn(async () => ({ big: 0.42, vague: 0.1 }));
    host[JEV_NOUL_JUDGE_KEY] = judge;

    expect(hasJevNoulJudge()).toBe(true);
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toEqual({ big: 0.42, vague: 0.1 });
    expect(judge).toHaveBeenCalledWith({ ...request, signal: expect.any(AbortSignal) });
  });

  it("drops probabilities for questions nobody asked", async () => {
    host[JEV_NOUL_JUDGE_KEY] = async () => ({ big: 0.4, vague: 0.6, extra: 0.9 });
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toEqual({ big: 0.4, vague: 0.6 });
  });

  it.each([0, 1])("accepts the boundary probability %s", async (probability) => {
    host[JEV_NOUL_JUDGE_KEY] = answer(probability, probability);
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toEqual({ big: probability, vague: probability });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1, "0.5", null, undefined])(
    "discards the whole answer when one probability is %s",
    async (bad) => {
      host[JEV_NOUL_JUDGE_KEY] = answer(0.2, bad);
      expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
      host[JEV_NOUL_JUDGE_KEY] = answer(bad, 0.2);
      expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
    },
  );

  it.each([[{ big: 0.2 }], [{}], [null], [0.3], [[0.1, 0.2]], ["big"]])(
    "is null for the incomplete or malformed answer %j",
    async (malformed) => {
      host[JEV_NOUL_JUDGE_KEY] = async () => malformed as never;
      expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
    },
  );

  it("does not accept inherited properties as answers", async () => {
    host[JEV_NOUL_JUDGE_KEY] = async () => Object.create({ big: 0.1, vague: 0.1 }) as never;
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
  });

  it("does not call the judge when there is nothing to ask", async () => {
    const judge = vi.fn(async () => ({}));
    host[JEV_NOUL_JUDGE_KEY] = judge;

    expect(await requestJevNoul({ state: {}, questions: {} }, { timeoutMs: 1_000 })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it("turns a rejection and a synchronous throw into null", async () => {
    host[JEV_NOUL_JUDGE_KEY] = async () => { throw new Error("Jev API error: 500"); };
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();

    host[JEV_NOUL_JUDGE_KEY] = () => { throw new Error("broken host"); };
    expect(await requestJevNoul(request, { timeoutMs: 1_000 })).toBeNull();
  });

  it("gives up at the timeout and aborts the signal it handed out", async () => {
    vi.useFakeTimers();
    const judge = vi.fn((_request: JevNoulRequest) => never());
    host[JEV_NOUL_JUDGE_KEY] = judge;

    const pending = requestJevNoul(request, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(499);
    expect(judge.mock.calls[0]![0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toBeNull();
    expect(judge.mock.calls[0]![0].signal?.aborted).toBe(true);
  });

  it("follows the caller's abort even when the judge ignores its signal", async () => {
    const controller = new AbortController();
    host[JEV_NOUL_JUDGE_KEY] = never;

    const pending = requestJevNoul(request, { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();

    expect(await pending).toBeNull();
  });

  it("does not call the judge for a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const judge = vi.fn(async () => ({ big: 0.1, vague: 0.1 }));
    host[JEV_NOUL_JUDGE_KEY] = judge;

    expect(await requestJevNoul(request, { timeoutMs: 1_000, signal: controller.signal })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it("leaves no timer behind once answered", async () => {
    vi.useFakeTimers();
    host[JEV_NOUL_JUDGE_KEY] = async () => ({ big: 0.3, vague: 0.3 });

    expect(await requestJevNoul(request, { timeoutMs: 60_000 })).toEqual({ big: 0.3, vague: 0.3 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

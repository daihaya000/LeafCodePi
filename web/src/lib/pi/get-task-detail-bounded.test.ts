import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({
  getTaskDetail: mocks.getTaskDetail,
}));

import { getTaskDetailBounded } from "./get-task-detail-bounded";

describe("getTaskDetailBounded", () => {
  beforeEach(() => {
    mocks.getTaskDetail.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the live detail when it resolves in time", async () => {
    mocks.getTaskDetail.mockResolvedValue({ id: "t1", messages: [] });
    await expect(getTaskDetailBounded("t1")).resolves.toEqual({
      id: "t1",
      messages: [],
    });
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("t1");
  });

  it("falls back to offline after timeout", async () => {
    mocks.getTaskDetail.mockImplementation((_id: string, options?: { offline?: boolean }) => {
      if (options?.offline) {
        return Promise.resolve({ id: "t1", messages: [], offline: true });
      }
      return new Promise(() => {});
    });

    const pending = getTaskDetailBounded("t1", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({
      id: "t1",
      messages: [],
      offline: true,
    });
    expect(mocks.getTaskDetail).toHaveBeenLastCalledWith("t1", { offline: true });
  });

  it("rejects with 503 when offline fallback also times out", async () => {
    mocks.getTaskDetail.mockImplementation(() => new Promise(() => {}));

    const pending = getTaskDetailBounded("t1", {
      timeoutMs: 1_000,
      offlineTimeoutMs: 500,
    });
    const expectation = expect(pending).rejects.toMatchObject({
      status: 503,
      message: "タスク詳細を取得できませんでした",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
  });
});

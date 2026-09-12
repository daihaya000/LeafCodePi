// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJson: vi.fn() }));

vi.mock("./client", () => ({ getJson: mocks.getJson }));

import { refreshBotSidebar, subscribeBotSidebar } from "./bot-sidebar-store";

describe("bot-sidebar-store", () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    mocks.getJson.mockReset();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  it("coalesces concurrent consumers into one request", async () => {
    let resolveRequest!: (value: { bots: []; rooms: [] }) => void;
    mocks.getJson.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    unsubscribe = subscribeBotSidebar(vi.fn());

    const first = refreshBotSidebar();
    const second = refreshBotSidebar();

    expect(second).toBe(first);
    expect(mocks.getJson).toHaveBeenCalledTimes(1);
    resolveRequest({ bots: [], rooms: [] });
    await expect(first).resolves.toMatchObject({ bots: [], rooms: [], error: null });
  });
});

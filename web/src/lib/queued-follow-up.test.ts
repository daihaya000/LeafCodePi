import { describe, expect, it } from "vitest";
import {
  shouldAutoSendQueuedFollowUp,
  shouldDrainQueuedFollowUp,
} from "./queued-follow-up";

const idle = {
  working: false,
  submitting: false,
  queuedAutoSend: false,
  goalLoopEnabled: false,
  goalLoopLive: false,
  stopRequested: false,
};

describe("queued follow-up drain", () => {
  it("drains the next item once the run is idle", () => {
    expect(shouldDrainQueuedFollowUp({ ...idle, hasQueuedItem: true })).toBe(true);
  });

  it("does not drain while working or already auto-sending", () => {
    expect(
      shouldDrainQueuedFollowUp({ ...idle, working: true, hasQueuedItem: true }),
    ).toBe(false);
    expect(
      shouldDrainQueuedFollowUp({
        ...idle,
        queuedAutoSend: true,
        hasQueuedItem: true,
      }),
    ).toBe(false);
  });

  it("does not drain after the user requested stop", () => {
    expect(
      shouldDrainQueuedFollowUp({
        ...idle,
        stopRequested: true,
        hasQueuedItem: true,
      }),
    ).toBe(false);
  });
});

describe("queued follow-up auto-send", () => {
  it("sends drained composer content when idle", () => {
    expect(
      shouldAutoSendQueuedFollowUp({
        ...idle,
        queuedAutoSend: true,
        hasContent: true,
      }),
    ).toBe(true);
  });

  it("does not auto-send after the user requested stop", () => {
    expect(
      shouldAutoSendQueuedFollowUp({
        ...idle,
        queuedAutoSend: true,
        stopRequested: true,
        hasContent: true,
      }),
    ).toBe(false);
  });

  it("does not auto-send an empty composer", () => {
    expect(
      shouldAutoSendQueuedFollowUp({
        ...idle,
        queuedAutoSend: true,
        hasContent: false,
      }),
    ).toBe(false);
  });
});

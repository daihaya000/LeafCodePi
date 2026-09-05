import { describe, expect, it } from "vitest";
import {
  shouldAutoSendQueuedFollowUp,
  shouldClearPendingUserMessageOnEvent,
  shouldClearQueuedFollowUpOnEvent,
  shouldDrainQueuedFollowUp,
  shouldQueueFollowUp,
} from "./queued-follow-up";

const idle = {
  working: false,
  submitting: false,
  queuedAutoSend: false,
  goalLoopEnabled: false,
  goalLoopLive: false,
  stopRequested: false,
};

describe("queued follow-up enqueue", () => {
  it("queues a follow-up only while working in queue mode", () => {
    expect(
      shouldQueueFollowUp({ working: true, deliveryMode: "queue", goalLoopEnabled: false }),
    ).toBe(true);
    expect(
      shouldQueueFollowUp({ working: true, deliveryMode: "steer", goalLoopEnabled: false }),
    ).toBe(false);
    expect(
      shouldQueueFollowUp({ working: false, deliveryMode: "queue", goalLoopEnabled: false }),
    ).toBe(false);
  });

  it("does not queue while a Goal loop is on, because drain never runs", () => {
    expect(
      shouldQueueFollowUp({ working: true, deliveryMode: "queue", goalLoopEnabled: true }),
    ).toBe(false);
    expect(
      shouldQueueFollowUp({
        working: true,
        deliveryMode: "queue",
        goalLoopEnabled: false,
        goalLoopLive: true,
      }),
    ).toBe(false);
  });
});

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

describe("queued follow-up hang events", () => {
  it("clears the client queue on hang abort, before hang retry", () => {
    expect(shouldClearQueuedFollowUpOnEvent("hang_abort")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent("hang_retry")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent("abort")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent(undefined)).toBe(false);
  });

  it("clears steer optimistic rows when abort drops the server queue", () => {
    expect(shouldClearPendingUserMessageOnEvent("abort")).toBe(true);
    expect(shouldClearPendingUserMessageOnEvent("hang_abort")).toBe(true);
    expect(shouldClearPendingUserMessageOnEvent("hang_retry")).toBe(true);
    expect(shouldClearPendingUserMessageOnEvent("prompt_accepted")).toBe(false);
    expect(shouldClearPendingUserMessageOnEvent(undefined)).toBe(false);
  });
});

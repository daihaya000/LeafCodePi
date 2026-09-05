import { describe, expect, it } from "vitest";
import {
  shouldAutoSendQueuedFollowUp,
  shouldClearPendingUserMessageOnEvent,
  shouldClearQueuedFollowUpOnAbortState,
  shouldClearQueuedFollowUpOnEvent,
  shouldDrainQueuedFollowUp,
  shouldQueueFollowUp,
  shouldSendSteerBehavior,
  shouldShowOptimisticPendingUser,
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

  it("does not drain while a silent resume is in flight", () => {
    expect(
      shouldDrainQueuedFollowUp({
        ...idle,
        resumingTurn: true,
        hasQueuedItem: true,
      }),
    ).toBe(false);
  });

  it("does not drain while SSE is reconnecting or hydrating", () => {
    expect(
      shouldDrainQueuedFollowUp({
        ...idle,
        sseReconnecting: true,
        hasQueuedItem: true,
      }),
    ).toBe(false);
    expect(
      shouldDrainQueuedFollowUp({
        ...idle,
        sessionHydrating: true,
        hasQueuedItem: true,
      }),
    ).toBe(false);
  });

  it("does not drain while context compaction is running", () => {
    expect(
      shouldDrainQueuedFollowUp({
        ...idle,
        compacting: true,
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

  it("does not auto-send while a silent resume is in flight", () => {
    expect(
      shouldAutoSendQueuedFollowUp({
        ...idle,
        queuedAutoSend: true,
        hasContent: true,
        resumingTurn: true,
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

  it("does not auto-send while context compaction is running", () => {
    expect(
      shouldAutoSendQueuedFollowUp({
        ...idle,
        queuedAutoSend: true,
        hasContent: true,
        compacting: true,
      }),
    ).toBe(false);
  });
});

describe("queued follow-up hang events", () => {
  it("clears the client queue on hang abort, before hang retry", () => {
    expect(shouldClearQueuedFollowUpOnEvent("hang_abort")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent("hang_idle")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent("hang_retry")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent("abort")).toBe(true);
    expect(shouldClearQueuedFollowUpOnEvent(undefined)).toBe(false);
  });

  it("clears the client queue when ready carries an abort sentinel", () => {
    expect(shouldClearQueuedFollowUpOnAbortState("")).toBe(true);
    expect(shouldClearQueuedFollowUpOnAbortState("a1")).toBe(true);
    expect(shouldClearQueuedFollowUpOnAbortState(null)).toBe(false);
    expect(shouldClearQueuedFollowUpOnAbortState(undefined)).toBe(false);
  });

  it("clears steer optimistic rows when abort drops the server queue", () => {
    expect(shouldClearPendingUserMessageOnEvent("abort")).toBe(true);
    expect(shouldClearPendingUserMessageOnEvent("hang_abort")).toBe(true);
    expect(shouldClearPendingUserMessageOnEvent("hang_retry")).toBe(true);
    expect(shouldClearPendingUserMessageOnEvent("prompt_accepted")).toBe(false);
    expect(shouldClearPendingUserMessageOnEvent(undefined)).toBe(false);
  });

  it("does not show an optimistic user row for steer sends", () => {
    expect(
      shouldShowOptimisticPendingUser({ working: true, deliveryMode: "steer" }),
    ).toBe(false);
    expect(
      shouldShowOptimisticPendingUser({ working: true, deliveryMode: "queue" }),
    ).toBe(true);
    expect(
      shouldShowOptimisticPendingUser({ working: false, deliveryMode: "steer" }),
    ).toBe(true);
  });

  it("sends steer while working even before the stream opens", () => {
    expect(shouldSendSteerBehavior({ working: true, deliveryMode: "steer" })).toBe(true);
    expect(shouldSendSteerBehavior({ working: false, deliveryMode: "steer" })).toBe(false);
    expect(shouldSendSteerBehavior({ working: true, deliveryMode: "queue" })).toBe(false);
  });
});

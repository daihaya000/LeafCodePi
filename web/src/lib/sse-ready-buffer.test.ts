import { describe, expect, it } from "vitest";
import {
  bufferPendingSsePayload,
  isFresherMessageList,
  rankMessageList,
  shouldFlushPendingAfterReady,
} from "./sse-ready-buffer";

describe("sse-ready-buffer", () => {
  it("ranks by length then tip createdAt", () => {
    expect(rankMessageList([{ id: "a", createdAt: 1 }])).toEqual({
      len: 1,
      lastCreatedAt: 1,
      lastId: "a",
    });
    expect(
      isFresherMessageList(
        { len: 2, lastCreatedAt: 1, lastId: "b" },
        { len: 1, lastCreatedAt: 9, lastId: "a" },
      ),
    ).toBe(true);
    expect(
      isFresherMessageList(
        { len: 1, lastCreatedAt: 2, lastId: "b" },
        { len: 1, lastCreatedAt: 1, lastId: "a" },
      ),
    ).toBe(true);
  });

  it("drops snapshots older than the ready tip", () => {
    const ready = rankMessageList([
      { id: "history", createdAt: 1 },
      { id: "latest", createdAt: 5 },
    ]);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "snapshot",
          messages: [{ id: "stale", createdAt: 2 }],
        },
        ready,
      ),
    ).toBe(false);
  });

  it("keeps snapshots newer than ready and streaming deltas of the tip", () => {
    const ready = rankMessageList([{ id: "history", createdAt: 1 }]);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "snapshot",
          messages: [{ id: "intermediate", createdAt: 2 }],
        },
        ready,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "delta",
          message: { id: "live-latest", createdAt: 3 },
        },
        ready,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "delta",
          message: { id: "history", createdAt: 1, parts: [{ text: "more" }] },
        },
        ready,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "delta",
          message: { id: "ancient", createdAt: 0 },
        },
        ready,
      ),
    ).toBe(false);
  });

  it("keeps control snapshots even when the message list is not newer", () => {
    const ready = rankMessageList([
      { id: "history", createdAt: 1 },
      { id: "latest", createdAt: 5 },
    ]);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "snapshot",
          eventType: "permission_request",
          messages: [
            { id: "history", createdAt: 1 },
            { id: "latest", createdAt: 5 },
          ],
          permissionRequest: { id: "req-1" },
        },
        ready,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "snapshot",
          eventType: "hang_retry",
          hangRetryCount: 2,
          messages: [
            { id: "history", createdAt: 1 },
            { id: "latest", createdAt: 5 },
          ],
        },
        ready,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "snapshot",
          eventType: "stale",
          messages: [{ id: "stale", createdAt: 2 }],
        },
        ready,
      ),
    ).toBe(false);
  });

  it("keeps control snapshots when a later history snapshot coalesces", () => {
    const pending: Record<string, unknown>[] = [];
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_request",
      permissionRequest: { id: "req-1" },
    });
    bufferPendingSsePayload(pending, {
      type: "delta",
      message: { id: "live" },
    });
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "intermediate",
      messages: [{ id: "m2", createdAt: 2 }],
    });
    expect(pending.map((item) => item.eventType ?? item.type)).toEqual([
      "permission_request",
      "intermediate",
    ]);
  });

  it("replaces the same control event type and coalesces trailing deltas", () => {
    const pending: Record<string, unknown>[] = [];
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_request",
      permissionRequest: { id: "req-1" },
    });
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_request",
      permissionRequest: { id: "req-2" },
    });
    bufferPendingSsePayload(pending, {
      type: "delta",
      message: { id: "d1" },
    });
    bufferPendingSsePayload(pending, {
      type: "delta",
      message: { id: "d2" },
    });
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ permissionRequest: { id: "req-2" } });
    expect(pending[1]).toMatchObject({ type: "delta", message: { id: "d2" } });
  });
});

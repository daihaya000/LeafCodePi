import { describe, expect, it } from "vitest";
import {
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
});

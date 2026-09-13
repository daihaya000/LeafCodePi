import { describe, expect, it } from "vitest";
import {
  bufferPendingSsePayload,
  isFresherMessageList,
  preparePendingPayloadForReadyFlush,
  rankMessageList,
  shouldFlushPendingAfterReady,
} from "./sse-ready-buffer";

describe("sse-ready-buffer", () => {
  it("ranks by length then tip createdAt", () => {
    expect(rankMessageList([{ id: "a", createdAt: 1 }])).toMatchObject({
      len: 1,
      lastCreatedAt: 1,
      lastId: "a",
    });
    expect(rankMessageList([{ id: "a", createdAt: 1 }]).contentKey).toBe('["{}"]');
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

  it("keeps same-length, same-timestamp snapshots when content changes", () => {
    const ready = rankMessageList([
      { id: "tip", createdAt: 5, role: "assistant", parts: [{ id: "part", type: "text", text: "before" }] },
    ]);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "snapshot",
          messages: [{ id: "tip", createdAt: 5, role: "assistant", parts: [{ id: "part", type: "text", text: "after" }] }],
        },
        ready,
      ),
    ).toBe(true);
    expect(
      isFresherMessageList(
        rankMessageList([{ id: "tip", createdAt: 5, role: "assistant", parts: [{ id: "part", type: "text", text: "after" }] }]),
        ready,
      ),
    ).toBe(true);
  });

  it("treats archived, restored, and conversation reset snapshots as control events", () => {
    const ready = rankMessageList([{ id: "latest", createdAt: 5 }]);
    for (const eventType of ["archived", "restored", "conversation_reset"]) {
      expect(
        shouldFlushPendingAfterReady({ type: "snapshot", eventType, messages: [{ id: "old", createdAt: 1 }] }, ready),
      ).toBe(true);
    }
    const reset = preparePendingPayloadForReadyFlush(
      { type: "snapshot", eventType: "conversation_reset", messages: [] },
      ready,
    );
    expect(reset?.messages).toEqual([]);
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

  it("drops buffered tip deltas that only differ by projected msg id", () => {
    const ready = rankMessageList([
      { id: "history", createdAt: 1 },
      { id: "entry-tip", createdAt: 5 },
    ]);
    expect(
      shouldFlushPendingAfterReady(
        {
          type: "delta",
          message: { id: "msg-2", createdAt: 5, parts: [{ text: "stale" }] },
        },
        ready,
      ),
    ).toBe(false);
    expect(
      isFresherMessageList(
        { len: 2, lastCreatedAt: 5, lastId: "msg-2" },
        { len: 2, lastCreatedAt: 5, lastId: "entry-tip" },
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
          eventType: "hang_abort",
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
          eventType: "prompt_accepted",
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

  it("strips stale messages from control payloads flushed after ready", () => {
    const ready = rankMessageList([
      { id: "history", createdAt: 1 },
      { id: "latest", createdAt: 5 },
    ]);
    const prepared = preparePendingPayloadForReadyFlush(
      {
        type: "snapshot",
        eventType: "permission_request",
        messages: [{ id: "history", createdAt: 1 }],
        messageHistory: { hasMore: true, nextCursor: "history" },
        todos: [],
        contextUsage: { used: 1, limit: 2 },
        permissionRequest: { id: "req-1" },
      },
      ready,
    );
    expect(prepared).toMatchObject({
      eventType: "permission_request",
      permissionRequest: { id: "req-1" },
    });
    expect(prepared).not.toHaveProperty("messages");
    expect(prepared).not.toHaveProperty("messageHistory");
    expect(prepared).not.toHaveProperty("todos");
    expect(prepared).not.toHaveProperty("contextUsage");

    const hangIdle = preparePendingPayloadForReadyFlush(
      {
        type: "snapshot",
        eventType: "hang_idle",
        messages: [{ id: "history", createdAt: 1 }],
        isStreaming: false,
        task: { status: "idle" },
      },
      ready,
    );
    expect(hangIdle).toMatchObject({
      eventType: "hang_idle",
      isStreaming: false,
      task: { status: "idle" },
    });
    expect(hangIdle).not.toHaveProperty("messages");

    const fresher = preparePendingPayloadForReadyFlush(
      {
        type: "snapshot",
        eventType: "permission_request",
        messages: [
          { id: "history", createdAt: 1 },
          { id: "latest", createdAt: 5 },
          { id: "newer", createdAt: 6 },
        ],
        permissionRequest: { id: "req-2" },
      },
      ready,
    );
    expect(fresher).toMatchObject({
      eventType: "permission_request",
      permissionRequest: { id: "req-2" },
    });
    expect(fresher?.messages).toHaveLength(3);
  });

  it("preserves reset history even when the reverted branch is shorter", () => {
    const ready = rankMessageList(Array.from({ length: 60 }, (_, index) => ({
      id: `old-${index}`,
      createdAt: index,
    })));
    const reverted = Array.from({ length: 3 }, (_, index) => ({
      id: `new-${index}`,
      createdAt: index,
    }));
    const prepared = preparePendingPayloadForReadyFlush(
      {
        type: "snapshot",
        eventType: "revert",
        historyReset: true,
        messages: reverted,
      },
      ready,
    );
    expect(prepared?.messages).toEqual(reverted);
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

  it("cancels a buffered permission request when resolved arrives", () => {
    const pending: Record<string, unknown>[] = [];
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_request",
      permissionRequest: { id: "req-1" },
    });
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_resolved",
      permissionRequest: null,
    });
    expect(pending).toEqual([]);
  });

  it("drops a stale resolved when a newer permission request arrives", () => {
    const pending: Record<string, unknown>[] = [];
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_request",
      permissionRequest: { id: "req-a" },
    });
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_resolved",
      permissionRequest: null,
    });
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_request",
      permissionRequest: { id: "req-b" },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      eventType: "permission_request",
      permissionRequest: { id: "req-b" },
    });
  });

  it("keeps a resolved clear when no request was buffered", () => {
    const pending: Record<string, unknown>[] = [];
    bufferPendingSsePayload(pending, {
      type: "snapshot",
      eventType: "permission_resolved",
      permissionRequest: null,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ eventType: "permission_resolved" });
  });
});

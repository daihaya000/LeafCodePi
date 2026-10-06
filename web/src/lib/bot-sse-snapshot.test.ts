import { describe, expect, it } from "vitest";
import { createBotSseSnapshotDeduper } from "./bot-sse-snapshot";

describe("createBotSseSnapshotDeduper", () => {
  it("omits repeated large snapshot fields but keeps reset messages and non-snapshot events", () => {
    const prepare = createBotSseSnapshotDeduper();
    const messages = [{ id: "m1", role: "assistant", text: "long transcript ".repeat(300) }];
    const bootstrap = {
      type: "snapshot",
      eventType: "bootstrap",
      task: { id: "bot:one", status: "working" },
      messages,
      messageHistory: { hasMore: false, nextCursor: null },
      intercomInbox: { unreadCount: 1, messages: [{ id: "i1", text: "hello" }] },
      isStreaming: true,
    };
    const first = prepare(bootstrap);
    expect(first.payload).toEqual(bootstrap);
    first.commit();

    const ready = prepare({ ...bootstrap, eventType: "ready" });
    expect(ready.payload).not.toHaveProperty("task");
    expect(ready.payload).not.toHaveProperty("messages");
    expect(ready.payload).not.toHaveProperty("messageHistory");
    expect(ready.payload).not.toHaveProperty("intercomInbox");
    expect(ready.payload.eventType).toBe("ready");
    expect(new TextEncoder().encode(JSON.stringify(bootstrap)).byteLength -
      new TextEncoder().encode(JSON.stringify(ready.payload)).byteLength).toBeGreaterThan(4_000);
    ready.commit();

    const changedInbox = prepare({
      type: "snapshot",
      eventType: "intercom_inbox",
      intercomInbox: { unreadCount: 2, messages: [{ id: "i2", text: "new" }] },
    });
    expect(changedInbox.payload.intercomInbox).toMatchObject({ unreadCount: 2 });
    changedInbox.commit();

    const reset = prepare({ ...bootstrap, eventType: "revert", historyReset: true });
    expect(reset.payload.messages).toEqual(messages);
    reset.commit();

    const oversized = { type: "snapshot", messages: [{ id: "large", text: "x".repeat(16_385) }] };
    const firstOversized = prepare(oversized);
    firstOversized.commit();
    expect(prepare(oversized).payload).toHaveProperty("messages");

    const delta = { type: "delta", message: { id: "m1", text: "token" } };
    expect(prepare(delta).payload).toBe(delta);
  });
});

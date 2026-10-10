import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";
import { MAX_FRAME_BYTES } from "./framing.ts";
import { EXACT_SEND_FEATURE } from "../types.ts";

function silentClient(): { client: IntercomClient; writes: Buffer[] } {
  const client = new IntercomClient();
  const writes: Buffer[] = [];
  (client as any)._sessionId = "abort-client";
  (client as any).socket = {
    destroyed: false, writableEnded: false, writable: true,
    write(chunk: Buffer) { writes.push(chunk); return true; },
  };
  return { client, writes };
}

test("aborting silent broker requests clears pending maps without disconnecting", async () => {
  const { client } = silentClient();
  for (const kind of ["list", "send", "cancel"] as const) {
    const controller = new AbortController();
    const request = kind === "list" ? client.listSessions({ signal: controller.signal })
      : kind === "send" ? client.send("target", { messageId: kind, text: kind, signal: controller.signal })
      : client.cancelMessage(kind, { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, /Cancelled/);
    assert.equal((client as any).pendingLists.size, 0);
    assert.equal((client as any).pendingSends.size, 0);
    assert.equal(client.isConnected(), true);
  }
});

test("pre-aborted requests never write to the broker", async () => {
  const { client, writes } = silentClient();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.listSessions({ signal: controller.signal }), /Cancelled/);
  await assert.rejects(client.send("target", { text: "not sent", signal: controller.signal }), /Cancelled/);
  await assert.rejects(client.cancelMessage("not cancelled", { signal: controller.signal }), /Cancelled/);
  assert.equal(writes.length, 0);
});

test("exact-send target resolution honours cancellation before message delivery", async () => {
  const { client, writes } = silentClient();
  (client as any)._features.add(EXACT_SEND_FEATURE);
  const controller = new AbortController();
  const request = client.send("target", { text: "not sent", signal: controller.signal });
  controller.abort();
  await assert.rejects(request, /Cancelled/);
  assert.equal((client as any).pendingLists.size, 0);
  assert.equal((client as any).pendingSends.size, 0);
  assert.ok(writes.length <= 2, "only a list frame may have been written");
});

test("aborting a duplicate send cannot cancel the original pending request", async () => {
  const { client } = silentClient();
  const original = client.send("target", { messageId: "duplicate-abort", text: "first" });
  const controller = new AbortController();
  const duplicate = client.send("target", { messageId: "duplicate-abort", text: "duplicate", signal: controller.signal });
  controller.abort();
  await assert.rejects(duplicate, /Cancelled|already pending/);
  assert.equal((client as any).pendingSends.size, 1);
  (client as any).handleBrokerMessage({ type: "delivered", messageId: "duplicate-abort" });
  assert.equal((await original).delivered, true);
});


test("validated session lifecycle messages reach broker-message subscribers", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  const received: unknown[] = [];
  client.onBrokerMessage((message) => received.push(message));
  const session = {
    id: "session-2",
    cwd: "/test",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
  };

  (client as any).handleBrokerMessage({ type: "session_joined", session });
  (client as any).handleBrokerMessage({ type: "presence_update", session });
  (client as any).handleBrokerMessage({ type: "session_left", sessionId: "session-2" });

  assert.deepEqual(received, [
    { type: "session_joined", session },
    { type: "presence_update", session },
    { type: "session_left", sessionId: "session-2" },
  ]);
});

test("registered feature negotiation rejects non-string feature entries", () => {
  const client = new IntercomClient();
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "registered", sessionId: "session-1", features: ["valid", 123] }),
    /Invalid registered features/,
  );
});

test("malformed extension broker messages are rejected", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";

  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_owner", namespace: "test/v1", ownerId: "owner" }),
    /Invalid extension_owner/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_owner", namespace: "test/v1", ownerEpoch: "epoch" }),
    /Invalid extension_owner/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_message", namespace: "test/v1" }),
    /Invalid extension_message/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_state", namespace: "test/v1", revision: -1 }),
    /Invalid extension_state/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_state_result", namespace: "test/v1", committed: "yes", revision: 1 }),
    /Invalid extension_state_result/,
  );
  assert.doesNotThrow(() => (client as any).handleBrokerMessage({
    type: "extension_message",
    namespace: "test/v1",
    fromSessionId: "session-2",
    payload: { peerOnly: true },
  }));
});

test("duplicate pending message IDs fail without orphaning the original send", async () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      return true;
    },
  };

  const first = client.send("target", { messageId: "same-id", text: "first" });
  const duplicate = client.send("target", { messageId: "same-id", text: "duplicate" });

  await assert.rejects(duplicate, /Delivery request already pending/);
  (client as any).handleBrokerMessage({ type: "delivered", messageId: "same-id" });
  assert.deepEqual(await first, {
    id: "same-id",
    delivered: true,
    delivery: "socket_delivered",
    retryable: false,
    outcomeKnown: true,
  });
});

test("cancelAsk ignores synchronous socket write failures", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.doesNotThrow(() => client.cancelAsk("ask-1"));
});

test("oversized sends fail locally without writing or disconnecting the client", async () => {
  const client = new IntercomClient();
  let writes = 0;
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      writes += 1;
      return true;
    },
  };

  await assert.rejects(
    client.send("target", { messageId: "oversized", text: "x".repeat(MAX_FRAME_BYTES) }),
    /exceeds maximum 1048576 bytes/,
  );
  assert.equal(writes, 0);
  assert.equal(client.isConnected(), true);
  assert.equal((client as any).pendingSends.size, 0);
});

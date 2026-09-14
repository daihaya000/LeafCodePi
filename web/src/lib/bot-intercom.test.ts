import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const botTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  return { ...actual, dataDir: () => botTestState.root, storePath: () => join(botTestState.root, "store.json") };
});

import { createBot, patchBot } from "@/lib/bots";
import { BOT_DEFAULT_TOOL_NAMES } from "@/lib/types";
import {
  BOT_INTERCOM_SCHEMA_VERSION,
  MAX_BOT_INTERCOM_ASK_ROUNDTRIPS,
  MAX_BOT_INTERCOM_DEPTH,
  askBotIntercom,
  botIntercomAttachmentsDirForTests,
  botIntercomMailboxPathForTests,
  botIntercomPresence,
  cancelBotIntercom,
  getBotIntercomInbox,
  listBotIntercomPeers,
  listPendingBotIntercomAsks,
  markBotIntercomInboxRead,
  replyBotIntercom,
  resetBotIntercomForTests,
  sendBotIntercom,
  setBotIntercomAskTimeoutMsForTests,
  setBotIntercomBusyLookup,
  setBotIntercomResidentLookup,
  setBotIntercomSteerHandler,
  fanoutBotIntercom,
  listBotIntercomCwdPeers,
  DEFAULT_BOT_INTERCOM_SCOPE_ID,
  MAX_BOT_INTERCOM_FANOUT,
  MAX_BOT_INTERCOM_FANOUT_DEPTH,
} from "./bot-intercom";

function enableIntercom(id: string) {
  const tools = [...new Set([...BOT_DEFAULT_TOOL_NAMES, "intercom" as const])];
  return patchBot(id, { tools, intercomEnabled: true });
}

describe("bot intercom Phase B contract", () => {
  let root = "";
  const residents = new Set<string>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-bot-intercom-"));
    botTestState.root = root;
    residents.clear();
    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
  });

  afterEach(() => {
    resetBotIntercomForTests();
    rmSync(root, { recursive: true, force: true });
    botTestState.root = "";
  });

  it("delivers send by Bot id into the recipient 1:1 inbox", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);

    const sent = sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "  確認お願いします  " });
    expect(sent).toMatchObject({
      v: BOT_INTERCOM_SCHEMA_VERSION,
      fromBotId: alice.id,
      toBotId: bob.id,
      text: "確認お願いします",
      depth: 0,
      kind: "send",
    });
    expect(sent.conversationId).toEqual(expect.any(String));
    const inbox = getBotIntercomInbox(bob.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.preview).toMatchObject({ fromBotId: alice.id, fromName: "Alice", text: "確認お願いします" });
    expect(inbox.messages.filter((message) => message.toBotId === bob.id)).toHaveLength(1);
    expect(getBotIntercomInbox(alice.id).unreadCount).toBe(0);
  });

  it("rejects destinations that are not a Bot id", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);

    expect(() => sendBotIntercom({ fromBotId: alice.id, to: "session-child-test", text: "hi" })).toThrow(/Bot id/i);
    expect(() => sendBotIntercom({ fromBotId: alice.id, to: "Bob", text: "hi" })).toThrow(/Bot id/i);
    expect(() => sendBotIntercom({ fromBotId: alice.id, to: bob.id.slice(0, 8), text: "hi" })).toThrow(/Bot id/i);
    expect(getBotIntercomInbox(bob.id).messages.filter((message) => message.toBotId === bob.id)).toHaveLength(0);
  });

  it("never trusts a caller-supplied fromBot identity", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    residents.add(bob.id);

    const sent = sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "from the running task",
    });
    expect(sent.fromBotId).toBe(alice.id);
    expect(sent.fromBotId).not.toBe(mallory.id);
    expect(getBotIntercomInbox(bob.id).messages.find((message) => message.toBotId === bob.id)?.fromBotId).toBe(alice.id);
  });

  it("enforces Room-aligned depth / loop limits on a 1:1 ping-pong", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);

    const hops: number[] = [];
    let from = alice.id;
    let to = bob.id;
    for (let i = 0; i <= MAX_BOT_INTERCOM_DEPTH; i += 1) {
      hops.push(sendBotIntercom({ fromBotId: from, to, text: `hop-${i}` }).depth);
      [from, to] = [to, from];
    }
    expect(hops).toEqual([0, 1, 2, 3]);
    expect(() => sendBotIntercom({ fromBotId: from, to, text: "too deep" })).toThrow(/depth/i);
    expect(getBotIntercomInbox(to).messages.some((message) => message.text === "too deep")).toBe(false);
  });

  it("does not start the DM path during a Room turn", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);

    expect(() => sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "should stay on room_handoff",
      roomTurn: true,
    })).toThrow(/Room turn|room_handoff/i);
    expect(() => { void askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "ask", roomTurn: true }); }).toThrow(/Room turn|room_handoff/i);
    expect(() => replyBotIntercom({ fromBotId: bob.id, text: "nope", roomTurn: true })).toThrow(/Room turn|room_handoff/i);
    expect(getBotIntercomInbox(bob.id).messages.filter((message) => message.toBotId === bob.id)).toHaveLength(0);
  });

  it("requires the opt-in setting and the intercom allowlist on both sides", () => {
    const sender = createBot({ name: "Sender" });
    const recipient = createBot({ name: "Recipient" });
    residents.add(recipient.id);

    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/opt-in|disabled/i);

    patchBot(sender.id, { intercomEnabled: true, tools: [...BOT_DEFAULT_TOOL_NAMES] });
    expect(getBotIntercomInbox(recipient.id).messages.filter((message) => message.toBotId === recipient.id)).toHaveLength(0);
    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/allowlist|opt-in|opted in|disabled/i);

    enableIntercom(sender.id);
    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/opted in|allow/i);

    patchBot(recipient.id, { intercomEnabled: true, tools: BOT_DEFAULT_TOOL_NAMES.filter((tool) => tool !== "intercom") });
    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/allow/i);

    enableIntercom(recipient.id);
    expect(sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "ok" }).toBotId).toBe(recipient.id);
  });

  it("queues send for a named Bot that is offline and keeps unread on disk", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;

    const sent = sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "offline mailbox" });
    expect(sent.queued).toBe(true);
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);
    expect(existsSync(botIntercomMailboxPathForTests(bob.id))).toBe(true);
    expect(JSON.parse(readFileSync(botIntercomMailboxPathForTests(bob.id), "utf8")).lastReadAt).toBe(0);

    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);
    expect(getBotIntercomInbox(bob.id).messages.some((message) => message.text === "offline mailbox")).toBe(true);
  });

  it("keeps server-side unread after a process restart and clears it only via mark-read", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "hello" });

    expect(listBotIntercomPeers(alice.id)).toEqual([
      expect.objectContaining({ id: bob.id, name: "Bob", resident: true, intercomEnabled: true }),
    ]);
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);

    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);
    expect(markBotIntercomInboxRead(bob.id).unreadCount).toBe(0);

    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(0);
  });

  it("returns an ask reply as the wait result and lists pending asks by Bot id", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);

    const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "可否は？" });
    expect(listPendingBotIntercomAsks(bob.id)).toEqual([
      expect.objectContaining({ fromBotId: alice.id, fromName: "Alice", text: "可否は？" }),
    ]);
    expect(getBotIntercomInbox(bob.id).pendingAsks).toHaveLength(1);

    const replied = replyBotIntercom({ fromBotId: bob.id, text: "  進めてください  " });
    expect(replied).toMatchObject({
      kind: "reply",
      fromBotId: bob.id,
      toBotId: alice.id,
      text: "進めてください",
      replyTo: expect.any(String),
    });
    await expect(waiting).resolves.toMatchObject({ id: replied.id, text: "進めてください", fromBotId: bob.id });
    expect(listPendingBotIntercomAsks(bob.id)).toHaveLength(0);
  });

  it("times out an unanswered ask with an explicit message id", async () => {
    vi.useFakeTimers();
    try {
      const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
      const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
      residents.add(bob.id);
      setBotIntercomAskTimeoutMsForTests(40);

      const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "will time out" });
      const askId = listPendingBotIntercomAsks(bob.id)[0]?.id;
      expect(askId).toEqual(expect.any(String));
      const expectation = expect(waiting).rejects.toThrow(
        new RegExp(`timed out.*${askId}`, "i"),
      );
      await vi.advanceTimersByTimeAsync(40);
      await expectation;
      expect(listPendingBotIntercomAsks(bob.id)).toHaveLength(0);
      expect(
        getBotIntercomInbox(bob.id).messages.some((message) => message.id === askId),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a same-thread ask-reply loop after the Room-aligned round-trip limit", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);

    for (let i = 0; i < MAX_BOT_INTERCOM_ASK_ROUNDTRIPS; i += 1) {
      const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: `ask-${i}` });
      replyBotIntercom({ fromBotId: bob.id, text: `reply-${i}` });
      await waiting;
    }

    expect(MAX_BOT_INTERCOM_ASK_ROUNDTRIPS).toBe(MAX_BOT_INTERCOM_DEPTH);
    expect(() => { void askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "loop" }); }).toThrow(/ask\/reply depth|depth/i);
    expect(getBotIntercomInbox(bob.id).messages.some((message) => message.text === "loop")).toBe(false);
  });

  it("does not double-deliver a second reply to the same ask", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);

    const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "once" });
    const first = replyBotIntercom({ fromBotId: bob.id, text: "first" });
    await expect(waiting).resolves.toMatchObject({ id: first.id });
    expect(() => replyBotIntercom({ fromBotId: bob.id, text: "second" })).toThrow(/pending ask/i);
    expect(getBotIntercomInbox(alice.id).messages.filter((message) => message.kind === "reply")).toHaveLength(1);
  });

  it("refuses a reverse mutual ask until the original ask is answered", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);

    const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "first" });
    expect(() => { void askBotIntercom({ fromBotId: bob.id, to: alice.id, text: "reverse" }); }).toThrow(/Mutual ask/i);
    replyBotIntercom({ fromBotId: bob.id, text: "answered" });
    await waiting;
    const next = askBotIntercom({ fromBotId: bob.id, to: alice.id, text: "now ok" });
    replyBotIntercom({ fromBotId: alice.id, text: "go ahead" });
    await expect(next).resolves.toMatchObject({ text: "go ahead" });
  });

  it("reloads a pending ask from the disk mailbox after restart so reply still works", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);

    const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "persist me" });
    waiting.catch(() => undefined);
    const askId = listPendingBotIntercomAsks(bob.id)[0]?.id;
    expect(askId).toBeTruthy();

    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
    expect(listPendingBotIntercomAsks(bob.id)[0]?.id).toBe(askId);

    const replied = replyBotIntercom({ fromBotId: bob.id, replyTo: askId, text: "after restart" });
    expect(replied.replyTo).toBe(askId);
    expect(getBotIntercomInbox(alice.id).messages.some((message) => message.text === "after restart")).toBe(true);
  });
});

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("bot intercom Phase C contract", () => {
  let root = "";
  const residents = new Set<string>();
  const busy = new Set<string>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-bot-intercom-c-"));
    botTestState.root = root;
    residents.clear();
    busy.clear();
    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
    setBotIntercomBusyLookup((id) => busy.has(id));
  });

  afterEach(() => {
    resetBotIntercomForTests();
    rmSync(root, { recursive: true, force: true });
    botTestState.root = "";
  });

  it("reports online, busy, and offline presence on peers and the inbox", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const carol = enableIntercom(createBot({ name: "Carol" }).id)!;
    residents.add(bob.id);
    residents.add(carol.id);
    busy.add(carol.id);

    expect(botIntercomPresence(bob.id)).toBe("online");
    expect(botIntercomPresence(carol.id)).toBe("busy");
    expect(botIntercomPresence(alice.id)).toBe("offline");
    expect(listBotIntercomPeers(alice.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: bob.id, presence: "online", resident: true }),
      expect.objectContaining({ id: carol.id, presence: "busy", resident: true }),
    ]));

    sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "hi" });
    expect(getBotIntercomInbox(alice.id).peerPresence).toMatchObject({ botId: bob.id, name: "Bob", status: "online" });
    expect(getBotIntercomInbox(bob.id).peerPresence).toMatchObject({ botId: alice.id, status: "offline" });
  });

  it("steers send to a busy resident Bot instead of queueing", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    busy.add(bob.id);
    const steered: string[] = [];
    setBotIntercomSteerHandler(async (message) => {
      steered.push(message.toBotId);
    });

    const sent = sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "steer this" });
    expect(sent.delivery).toBe("steered");
    expect(sent.queued).toBeUndefined();
    expect(getBotIntercomInbox(bob.id).messages.some((message) => message.text === "steer this")).toBe(true);
    await vi.waitFor(() => expect(steered).toEqual([bob.id]));
  });

  it("accepts Room-aligned attachments and rejects oversize, bad MIME, and too many", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);

    const sent = sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "files",
      attachments: [
        { mimeType: "image/png", data: PNG_1X1 },
        { name: "note.txt", mimeType: "text/plain", data: Buffer.from("hello", "utf8").toString("base64") },
      ],
    });
    expect(sent.attachments).toEqual([
      expect.objectContaining({ kind: "image", mimeType: "image/png", name: "image-1.png" }),
      expect.objectContaining({ kind: "file", mimeType: "text/plain", name: "note.txt" }),
    ]);
    expect(existsSync(join(botIntercomAttachmentsDirForTests(), sent.attachments![0]!.file))).toBe(true);
    expect(getBotIntercomInbox(bob.id).messages[0]?.attachments).toHaveLength(2);

    expect(() => sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "svg",
      attachments: [{ mimeType: "image/svg+xml", name: "x.svg", data: Buffer.from("<svg/>", "utf8").toString("base64") }],
    })).toThrow(/画像形式/);

    expect(() => sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "binary",
      attachments: [{ name: "blob.bin", mimeType: "application/octet-stream", data: Buffer.from([0xff, 0xfe]).toString("base64") }],
    })).toThrow(/UTF-8|テキスト/);

    expect(() => sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "too many images",
      attachments: Array.from({ length: 9 }, () => ({ mimeType: "image/png", data: PNG_1X1 })),
    })).toThrow(/画像は8件/);

    const huge = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    expect(() => sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "too big",
      attachments: [{ mimeType: "image/png", data: huge }],
    })).toThrow(/8MB|不正/);
  });

  it("cancels an outbound send for both sender and recipient and drops unread", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    residents.add(bob.id);

    const sent = sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "take this back" });
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);

    const cancelled = cancelBotIntercom({ fromBotId: alice.id, messageId: sent.id });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.delivery).toBe("cancelled");
    expect(getBotIntercomInbox(bob.id).messages.find((message) => message.id === sent.id)).toMatchObject({
      cancelled: true,
      delivery: "cancelled",
    });
    expect(getBotIntercomInbox(alice.id).messages.find((message) => message.id === sent.id)?.cancelled).toBe(true);
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(0);

    expect(() => cancelBotIntercom({ fromBotId: bob.id, messageId: sent.id })).toThrow(/sender/i);
    expect(() => cancelBotIntercom({ fromBotId: mallory.id, messageId: sent.id })).toThrow(/Unknown message|sender/i);
    expect(() => cancelBotIntercom({ fromBotId: alice.id, messageId: sent.id })).toThrow(/already cancelled or superseded/i);
  });

  it("supersedes only on the same sender-recipient pair and replaces both mailboxes", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const carol = enableIntercom(createBot({ name: "Carol" }).id)!;
    residents.add(bob.id);
    residents.add(carol.id);

    const first = sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "old" });
    expect(() => sendBotIntercom({
      fromBotId: alice.id,
      to: carol.id,
      text: "wrong pair",
      supersedes: first.id,
    })).toThrow(/same sender and recipient/i);

    const replacement = sendBotIntercom({
      fromBotId: alice.id,
      to: bob.id,
      text: "new",
      supersedes: first.id,
      retryOf: first.id,
    });
    expect(replacement.supersedes).toBe(first.id);
    expect(replacement.retryOf).toBe(first.id);
    expect(getBotIntercomInbox(bob.id).messages.find((message) => message.id === first.id)).toMatchObject({
      supersededBy: replacement.id,
      delivery: "superseded",
    });
    expect(getBotIntercomInbox(alice.id).messages.find((message) => message.id === first.id)?.supersededBy).toBe(replacement.id);
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);
    expect(getBotIntercomInbox(bob.id).messages.some((message) => message.text === "new")).toBe(true);
  });

  it("cancels a pending ask for both sides and rejects the waiter", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);
    busy.add(bob.id);

    const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "still?" });
    const askId = listPendingBotIntercomAsks(bob.id)[0]?.id;
    expect(askId).toEqual(expect.any(String));
    expect(getBotIntercomInbox(alice.id).messages.find((message) => message.id === askId)?.delivery).toBe("steered");

    cancelBotIntercom({ fromBotId: alice.id, messageId: askId! });
    await expect(waiting).rejects.toThrow(/Cancelled/);
    expect(listPendingBotIntercomAsks(bob.id)).toHaveLength(0);
    expect(getBotIntercomInbox(bob.id).messages.find((message) => message.id === askId)?.cancelled).toBe(true);
  });

  it("does not start cancel during a Room turn", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    const sent = sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "keep" });
    expect(() => cancelBotIntercom({ fromBotId: alice.id, messageId: sent.id, roomTurn: true })).toThrow(/Room turn|room_handoff/i);
    expect(getBotIntercomInbox(bob.id).messages.find((message) => message.id === sent.id)?.cancelled).toBeUndefined();
  });
});

describe("bot intercom Phase D contract", () => {
  let root = "";
  const residents = new Set<string>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-bot-intercom-d-"));
    botTestState.root = root;
    residents.clear();
    resetBotIntercomForTests();
    setBotIntercomResidentLookup((id) => residents.has(id));
  });

  afterEach(() => {
    resetBotIntercomForTests();
    rmSync(root, { recursive: true, force: true });
    botTestState.root = "";
  });

  it("omits out-of-scope Bots from list and rejects send", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    patchBot(mallory.id, { intercomScopeId: "other-project" });
    residents.add(bob.id);
    residents.add(mallory.id);

    expect(listBotIntercomPeers(alice.id).map((peer) => peer.id)).toEqual([bob.id]);
    expect(listBotIntercomPeers(alice.id)[0]?.scopeId).toBe(DEFAULT_BOT_INTERCOM_SCOPE_ID);
    expect(() => sendBotIntercom({ fromBotId: alice.id, to: mallory.id, text: "cross talk" })).toThrow(/out of scope/i);
    expect(() => { void askBotIntercom({ fromBotId: alice.id, to: mallory.id, text: "cross talk" }); }).toThrow(/out of scope/i);
    expect(getBotIntercomInbox(mallory.id).messages.filter((message) => message.toBotId === mallory.id)).toHaveLength(0);
  });

  it("treats list-cwd without a path as the same-scope roster and filters extraRoots when cwd is set", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const carol = enableIntercom(createBot({ name: "Carol" }).id)!;
    const shared = join(root, "shared-proj");
    const other = join(root, "other-proj");
    patchBot(alice.id, { extraRoots: [shared] });
    patchBot(bob.id, { extraRoots: [shared] });
    patchBot(carol.id, { extraRoots: [other] });

    expect(listBotIntercomCwdPeers(alice.id).map((peer) => peer.id).sort()).toEqual([bob.id, carol.id].sort());
    expect(listBotIntercomCwdPeers(alice.id, shared).map((peer) => peer.id)).toEqual([bob.id]);
    expect(listBotIntercomCwdPeers(alice.id, other).map((peer) => peer.id)).toEqual([carol.id]);
  });

  it("keeps fanout off until the sender opts in, then delivers only same-scope ids", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const carol = enableIntercom(createBot({ name: "Carol" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    patchBot(mallory.id, { intercomScopeId: "other-project" });
    residents.add(bob.id);
    residents.add(carol.id);
    residents.add(mallory.id);

    expect(MAX_BOT_INTERCOM_FANOUT_DEPTH).toBe(0);
    expect(() => fanoutBotIntercom({ fromBotId: alice.id, to: [bob.id, carol.id], text: "standup" })).toThrow(/opt-in|disabled/i);
    expect(getBotIntercomInbox(bob.id).messages).toHaveLength(0);

    patchBot(alice.id, { intercomFanoutEnabled: true });
    expect(() => fanoutBotIntercom({
      fromBotId: alice.id,
      to: [bob.id, mallory.id],
      text: "no partial",
    })).toThrow(/out of scope/i);
    expect(getBotIntercomInbox(bob.id).messages.filter((message) => message.text === "no partial")).toHaveLength(0);

    const sent = fanoutBotIntercom({ fromBotId: alice.id, to: [bob.id, carol.id], text: "standup" });
    expect(sent).toHaveLength(2);
    expect(sent.every((message) => message.fanout === true && message.fanoutDepth === 0 && message.scopeId === DEFAULT_BOT_INTERCOM_SCOPE_ID)).toBe(true);
    expect(getBotIntercomInbox(bob.id).messages.some((message) => message.text === "standup" && message.fanout)).toBe(true);
    expect(getBotIntercomInbox(carol.id).messages.some((message) => message.text === "standup")).toBe(true);
  });

  it("rejects fanout over the recipient cap and does not amplify a received fanout", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    patchBot(alice.id, { intercomFanoutEnabled: true });
    const extras = Array.from({ length: MAX_BOT_INTERCOM_FANOUT + 1 }, (_, index) => (
      enableIntercom(createBot({ name: `Peer-${index}` }).id)!
    ));
    expect(() => fanoutBotIntercom({
      fromBotId: alice.id,
      to: extras.map((bot) => bot.id),
      text: "too many",
    })).toThrow(/count/i);
    expect(getBotIntercomInbox(extras[0]!.id).messages).toHaveLength(0);

    const bob = extras[0]!;
    const carol = extras[1]!;
    residents.add(bob.id);
    residents.add(carol.id);
    fanoutBotIntercom({ fromBotId: alice.id, to: [bob.id, carol.id], text: "wave" });
    patchBot(bob.id, { intercomFanoutEnabled: true });
    expect(() => fanoutBotIntercom({ fromBotId: bob.id, to: [alice.id, carol.id], text: "amplify" })).toThrow(/fanout depth/i);
    expect(getBotIntercomInbox(carol.id).messages.filter((message) => message.text === "amplify")).toHaveLength(0);
  });

  it("does not start fanout during a Room turn", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    patchBot(alice.id, { intercomFanoutEnabled: true });
    residents.add(bob.id);
    expect(() => fanoutBotIntercom({
      fromBotId: alice.id,
      to: [bob.id],
      text: "room fanout",
      roomTurn: true,
    })).toThrow(/Room turn|room_handoff/i);
    expect(getBotIntercomInbox(bob.id).messages).toHaveLength(0);
  });
});

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
  botIntercomMailboxPathForTests,
  getBotIntercomInbox,
  listBotIntercomPeers,
  listPendingBotIntercomAsks,
  markBotIntercomInboxRead,
  replyBotIntercom,
  resetBotIntercomForTests,
  sendBotIntercom,
  setBotIntercomAskTimeoutMsForTests,
  setBotIntercomResidentLookup,
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
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    setBotIntercomAskTimeoutMsForTests(40);

    const waiting = askBotIntercom({ fromBotId: alice.id, to: bob.id, text: "will time out" });
    const askId = listPendingBotIntercomAsks(bob.id)[0]?.id;
    expect(askId).toEqual(expect.any(String));
    await expect(waiting).rejects.toThrow(new RegExp(`timed out.*${askId}`, "i"));
    expect(listPendingBotIntercomAsks(bob.id)).toHaveLength(0);
    expect(getBotIntercomInbox(bob.id).messages.some((message) => message.id === askId)).toBe(true);
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

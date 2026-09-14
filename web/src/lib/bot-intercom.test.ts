import { mkdtempSync, rmSync } from "node:fs";
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
  MAX_BOT_INTERCOM_DEPTH,
  getBotIntercomInbox,
  listBotIntercomPeers,
  markBotIntercomInboxRead,
  resetBotIntercomForTests,
  sendBotIntercom,
  setBotIntercomResidentLookup,
} from "./bot-intercom";

function enableIntercom(id: string) {
  const tools = [...new Set([...BOT_DEFAULT_TOOL_NAMES, "intercom" as const])];
  return patchBot(id, { tools, intercomEnabled: true });
}

describe("bot intercom Phase A contract", () => {
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
    });
    const inbox = getBotIntercomInbox(bob.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.preview).toMatchObject({ fromBotId: alice.id, fromName: "Alice", text: "確認お願いします" });
    expect(inbox.messages).toHaveLength(1);
    expect(getBotIntercomInbox(alice.id).messages).toHaveLength(0);
  });

  it("rejects destinations that are not a Bot id", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);

    expect(() => sendBotIntercom({ fromBotId: alice.id, to: "session-child-test", text: "hi" })).toThrow(/Bot id/i);
    expect(() => sendBotIntercom({ fromBotId: alice.id, to: "Bob", text: "hi" })).toThrow(/Bot id/i);
    expect(() => sendBotIntercom({ fromBotId: alice.id, to: bob.id.slice(0, 8), text: "hi" })).toThrow(/Bot id/i);
    expect(getBotIntercomInbox(bob.id).messages).toHaveLength(0);
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
    expect(getBotIntercomInbox(bob.id).messages[0]?.fromBotId).toBe(alice.id);
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
    expect(getBotIntercomInbox(bob.id).messages).toHaveLength(0);
  });

  it("requires the opt-in setting and the intercom allowlist on both sides", () => {
    const sender = createBot({ name: "Sender" });
    const recipient = createBot({ name: "Recipient" });
    residents.add(recipient.id);

    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/opt-in|disabled/i);

    patchBot(sender.id, { intercomEnabled: true, tools: [...BOT_DEFAULT_TOOL_NAMES] });
    expect(getBotIntercomInbox(recipient.id).messages).toHaveLength(0);
    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/allowlist|opt-in|opted in|disabled/i);

    enableIntercom(sender.id);
    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/opted in|allow/i);

    patchBot(recipient.id, { intercomEnabled: true, tools: BOT_DEFAULT_TOOL_NAMES.filter((tool) => tool !== "intercom") });
    expect(() => sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "nope" })).toThrow(/allow/i);

    enableIntercom(recipient.id);
    expect(sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "ok" }).toBotId).toBe(recipient.id);
  });

  it("rejects a non-resident destination", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    expect(() => sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "offline" })).toThrow(/resident/i);
    residents.add(bob.id);
    expect(sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "online" }).toBotId).toBe(bob.id);
  });

  it("lists other Bots by id and marks the inbox read", () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    sendBotIntercom({ fromBotId: alice.id, to: bob.id, text: "hello" });

    expect(listBotIntercomPeers(alice.id)).toEqual([
      expect.objectContaining({ id: bob.id, name: "Bob", resident: true, intercomEnabled: true }),
    ]);
    expect(getBotIntercomInbox(bob.id).unreadCount).toBe(1);
    expect(markBotIntercomInboxRead(bob.id).unreadCount).toBe(0);
  });
});

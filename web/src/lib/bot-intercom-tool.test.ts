import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const botTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  return { ...actual, dataDir: () => botTestState.root, storePath: () => join(botTestState.root, "store.json") };
});

import { createBot, getBot, patchBot } from "@/lib/bots";
import { createRoom, ensureRoomBotTask, getRoom } from "@/lib/rooms";
import { getTask } from "@/lib/store";
import { BOT_DEFAULT_TOOL_NAMES } from "@/lib/types";
import {
  getBotIntercomInbox,
  resetBotIntercomForTests,
  setBotIntercomAskTimeoutMsForTests,
  setBotIntercomBusyLookup,
  setBotIntercomResidentLookup,
} from "./bot-intercom";
import { BOT_INTERCOM_TOOL, botIntercomTool } from "./bot-intercom-tool";

function enableIntercom(id: string) {
  return patchBot(id, { intercomEnabled: true, tools: [...new Set([...BOT_DEFAULT_TOOL_NAMES, "intercom" as const])] });
}

type RegisteredTool = {
  name: string;
  execute: (callId: string, input: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
  }>;
};

function install(originTaskId: string): { tool: RegisteredTool; sessionStarts: number } {
  let tool: RegisteredTool | undefined;
  let sessionStarts = 0;
  const hooks = new Map<string, () => void>();
  botIntercomTool(originTaskId)({
    registerTool(next: unknown) { tool = next as RegisteredTool; },
    on(name: string, handler: () => void) {
      hooks.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  hooks.get("session_start")?.();
  sessionStarts += 1;
  if (!tool) throw new Error("intercom tool was not registered");
  return { tool, sessionStarts };
}

describe("bot intercom tool", () => {
  let root = "";
  const residents = new Set<string>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-bot-intercom-tool-"));
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

  it("sends with the running task Bot id and ignores spoofed fromBot fields", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    residents.add(bob.id);
    const { tool } = install(`bot:${alice.id}`);

    const result = await tool.execute("call", {
      action: "send",
      to: bob.id,
      message: "hello from the task",
      fromBot: mallory.id,
      fromBotId: mallory.id,
    });

    expect(tool.name).toBe(BOT_INTERCOM_TOOL);
    expect(result.details).toMatchObject({ fromBotId: alice.id, toBotId: bob.id });
    expect(result.details.error).toBeUndefined();
    expect(result.details.fromBotId).not.toBe(mallory.id);
    expect(getBotIntercomInbox(bob.id).messages[0]?.fromBotId).toBe(alice.id);
  });

  it("rejects a raw session id destination", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const { tool } = install(`bot:${alice.id}`);
    const result = await tool.execute("call", {
      action: "send",
      to: "session-child-test",
      message: "nope",
    });
    expect(result.details.error).toBe(true);
    expect(result.content[0]?.text).toMatch(/Bot id/i);
  });

  it("does not fire DM during a Room turn and does not register a room handoff", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const room = createRoom({ name: "Room", members: [alice.id, bob.id] });
    residents.add(bob.id);
    const roomTaskId = ensureRoomBotTask(room, getBot(alice.id)!);
    expect(getTask(roomTaskId)?.botId).toBe(alice.id);

    const { tool } = install(roomTaskId);
    const result = await tool.execute("call", {
      action: "send",
      to: bob.id,
      message: "room should not DM",
    });
    expect(result.details.error).toBe(true);
    expect(result.content[0]?.text).toMatch(/Room turn|room_handoff/i);
    expect(getBotIntercomInbox(bob.id).messages).toHaveLength(0);
    expect(getRoom(room.id)?.handoffs ?? []).toHaveLength(0);
  });

  it("re-registers on session_start so the Bot roster bridge wins", () => {
    const alice = createBot({ name: "Alice" });
    const { sessionStarts, tool } = install(`bot:${alice.id}`);
    expect(sessionStarts).toBe(1);
    expect(tool.name).toBe("intercom");
  });

  it("waits for ask and returns the reply as the tool result", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    residents.add(alice.id);
    residents.add(bob.id);
    const aliceTool = install(`bot:${alice.id}`).tool;
    const bobTool = install(`bot:${bob.id}`).tool;

    const pending = aliceTool.execute("ask", {
      action: "ask",
      to: bob.id,
      message: "可否は？",
      fromBot: mallory.id,
      fromBotId: mallory.id,
    });
    const listed = await bobTool.execute("pending", { action: "pending" });
    expect(listed.content[0]?.text).toMatch(/Alice/);
    expect(listed.details.error).toBeUndefined();

    const reply = await bobTool.execute("reply", {
      action: "reply",
      message: "進めてください",
      fromBot: mallory.id,
    });
    expect(reply.details).toMatchObject({ fromBotId: bob.id, toBotId: alice.id });
    const asked = await pending;
    expect(asked.details.error).toBeUndefined();
    expect(asked.content[0]?.text).toMatch(/進めてください/);
    expect(asked.details.fromBotId).toBe(bob.id);
    expect(asked.details.fromBotId).not.toBe(mallory.id);
  });

  it("returns an explicit ask timeout from the tool", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    setBotIntercomAskTimeoutMsForTests(40);
    const { tool } = install(`bot:${alice.id}`);
    const result = await tool.execute("ask", { action: "ask", to: bob.id, message: "timeout?" });
    expect(result.details.error).toBe(true);
    expect(result.content[0]?.text).toMatch(/timed out/i);
  });

  it("does not fire ask during a Room turn", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const room = createRoom({ name: "Room", members: [alice.id, bob.id] });
    residents.add(bob.id);
    const { tool } = install(ensureRoomBotTask(room, getBot(alice.id)!));
    const result = await tool.execute("ask", { action: "ask", to: bob.id, message: "room ask" });
    expect(result.details.error).toBe(true);
    expect(result.content[0]?.text).toMatch(/Room turn|room_handoff/i);
    expect(getBotIntercomInbox(bob.id).pendingAsks).toHaveLength(0);
  });

  it("lists presence and steers or cancels without spoofing the sender", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    const mallory = enableIntercom(createBot({ name: "Mallory" }).id)!;
    residents.add(bob.id);
    setBotIntercomBusyLookup((id) => id === bob.id);
    const aliceTool = install(`bot:${alice.id}`).tool;
    const malloryTool = install(`bot:${mallory.id}`).tool;

    const listed = await aliceTool.execute("list", { action: "list" });
    expect(listed.content[0]?.text).toMatch(/busy/);
    expect((listed.details.bots as { id: string; presence: string }[]).find((peer) => peer.id === bob.id)?.presence).toBe("busy");

    const sent = await aliceTool.execute("send", {
      action: "send",
      to: bob.id,
      message: "steer me",
      fromBotId: mallory.id,
    });
    expect(sent.details.error).toBeUndefined();
    expect(sent.details.fromBotId).toBe(alice.id);
    expect(sent.details.delivery).toBe("steered");
    expect(sent.content[0]?.text).toMatch(/Steered/);

    const cancelled = await aliceTool.execute("cancel", {
      action: "cancel",
      messageId: sent.details.messageId,
      fromBot: mallory.id,
    });
    expect(cancelled.details).toMatchObject({ fromBotId: alice.id, cancelled: true, delivery: "cancelled" });

    const again = await aliceTool.execute("send", { action: "send", to: bob.id, message: "old" });
    const replaced = await aliceTool.execute("send", {
      action: "send",
      to: bob.id,
      message: "new",
      supersedes: again.details.messageId,
    });
    expect(replaced.details.supersedes).toBe(again.details.messageId);

    const stolen = await malloryTool.execute("cancel", { action: "cancel", messageId: replaced.details.messageId });
    expect(stolen.details.error).toBe(true);

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const attached = await aliceTool.execute("send", {
      action: "send",
      to: bob.id,
      message: "pic",
      attachments: [{ mimeType: "image/png", data: png }],
    });
    expect(attached.details.error).toBeUndefined();
    expect(attached.details.attachments).toEqual([expect.objectContaining({ kind: "image", mimeType: "image/png" })]);
  });

  it("does not fire cancel during a Room turn", async () => {
    const alice = enableIntercom(createBot({ name: "Alice" }).id)!;
    const bob = enableIntercom(createBot({ name: "Bob" }).id)!;
    residents.add(bob.id);
    const sent = await install(`bot:${alice.id}`).tool.execute("send", { action: "send", to: bob.id, message: "keep" });
    const room = createRoom({ name: "Room", members: [alice.id, bob.id] });
    const { tool } = install(ensureRoomBotTask(room, getBot(alice.id)!));
    const result = await tool.execute("cancel", { action: "cancel", messageId: sent.details.messageId });
    expect(result.details.error).toBe(true);
    expect(result.content[0]?.text).toMatch(/Room turn|room_handoff/i);
    expect(getBotIntercomInbox(bob.id).messages.find((message) => message.id === sent.details.messageId)?.cancelled).toBeUndefined();
  });
});

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
import { getBotIntercomInbox, resetBotIntercomForTests, setBotIntercomResidentLookup } from "./bot-intercom";
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
});

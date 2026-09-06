import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const testState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => testState.root, storePath: () => join(testState.root, "store.json") }; });
import { botTaskId, createBot, deleteBot } from "./bots";
import { botsForRoomPrompt, consumeRoomRelayEnvelope, createRoom, deleteRoom, ensureRoomBotTask, getRoom, issueRoomRelayEnvelope, patchRoom } from "./rooms";
import { getTask } from "./store";

describe("room store and mention routing", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-rooms-")); testState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); testState.root = ""; });
  it("persists a room and keeps only bot allowlist members", () => {
    const first = createBot({ name: "Alpha" });
    const second = createBot({ name: "Beta" });
    const room = createRoom({ name: "Team", members: [first.id, "not-a-bot", second.id] });
    expect(getRoom(room.id)?.members).toEqual([first.id, second.id]);
    expect(readFileSync(join(root, "bots", "rooms", `${room.id}.json`), "utf8")).toContain('"members"');
    expect(patchRoom(room.id, { members: [second.id] })?.members).toEqual([second.id]);
  });
  it("routes no mention, named mention, and broadcast correctly", () => {
    const alpha = createBot({ name: "Alpha" });
    const beta = createBot({ name: "Beta" });
    const room = createRoom({ members: [alpha.id, beta.id] });
    expect(botsForRoomPrompt(room, "hello").bots).toEqual([]);
    expect(botsForRoomPrompt(room, "@Alpha please").bots.map((bot) => bot.id)).toEqual([alpha.id]);
    expect(botsForRoomPrompt(room, "@everyone please").bots.map((bot) => bot.id)).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    expect(botsForRoomPrompt(room, "@here please").bots.map((bot) => bot.id)).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    expect(botsForRoomPrompt(room, "@channel please").bots.map((bot) => bot.id)).toEqual(expect.arrayContaining([alpha.id, beta.id]));
  });
  it("answers room prompts in a room session instead of the 1:1 bot session", () => {
    const alpha = createBot({ name: "Alpha" });
    const room = createRoom({ name: "Team", members: [alpha.id] });
    const taskId = ensureRoomBotTask(room, alpha);
    expect(taskId).not.toBe(botTaskId(alpha.id));
    expect(getTask(taskId)?.botId).toBe(alpha.id);
    expect(ensureRoomBotTask(room, alpha)).toBe(taskId);
    expect(deleteRoom(room.id)).toBe(true);
    expect(getTask(taskId)).toBeUndefined();
    expect(getTask(botTaskId(alpha.id))).toBeDefined();
  });
  it("drops room sessions when the bot is deleted", () => {
    const alpha = createBot({ name: "Alpha" });
    const room = createRoom({ members: [alpha.id] });
    const taskId = ensureRoomBotTask(room, alpha);
    expect(deleteBot(alpha.id)).toBe(true);
    expect(getTask(taskId)).toBeUndefined();
    expect(getTask(botTaskId(alpha.id))).toBeUndefined();
  });
  it("enforces server-side relay depth and turn participants", () => {
    const bots = ["A", "B", "C", "D", "E", "F"].map((name) => createBot({ name }));
    const room = createRoom({ members: bots.map((bot) => bot.id) });
    patchRoom(room.id, { botRelayEnabled: true });
    let envelope = issueRoomRelayEnvelope(room.id, bots[0].id, [bots[1].id]);
    expect(envelope).toBeDefined();
    expect(consumeRoomRelayEnvelope(room.id, envelope!)).toBeDefined();
    envelope = issueRoomRelayEnvelope(room.id, bots[1].id, [bots[2].id], envelope!);
    expect(envelope).toBeDefined();
    expect(consumeRoomRelayEnvelope(room.id, envelope!)).toBeDefined();
    envelope = issueRoomRelayEnvelope(room.id, bots[2].id, [bots[3].id], envelope!);
    expect(envelope).toBeDefined();
    expect(consumeRoomRelayEnvelope(room.id, envelope!)).toBeDefined();
    envelope = issueRoomRelayEnvelope(room.id, bots[3].id, [bots[4].id], envelope!);
    expect(envelope).toBeDefined();
    expect(consumeRoomRelayEnvelope(room.id, envelope!)).toBeDefined();
    expect(issueRoomRelayEnvelope(room.id, bots[4].id, [bots[5].id], envelope!)).toBeUndefined();
  });
});

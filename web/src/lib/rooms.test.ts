import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const testState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => testState.root, storePath: () => join(testState.root, "store.json") }; });
import { botTaskId, createBot, deleteBot, patchBot } from "./bots";
import { appendRoomMessage, botsForRoomPrompt, consumeRoomRelayEnvelope, createRoom, deleteRoom, ensureRoomBotTask, getRoom, issueRoomRelayEnvelope, patchRoom } from "./rooms";
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
  it("matches complete mentions, preferring the longest name and escaping regex characters", () => {
    const bots = ["A", "Alpha", "Code", "Code Reviewer", "設計", "設計者", "C++"].map((name) => createBot({ name }));
    const room = createRoom({ members: bots.map((bot) => bot.id) });
    for (const bot of bots) {
      expect(botsForRoomPrompt(room, `@${bot.name} please`, false, bots).bots.map((member) => member.id)).toEqual([bot.id]);
      expect(botsForRoomPrompt(room, `@${bot.id}`, false, bots).bots.map((member) => member.id)).toEqual([bot.id]);
    }
    expect(botsForRoomPrompt(room, "user@Alpha.example @AlphaExtra @here-other @everyoneElse", false, bots).bots).toEqual([]);
    expect(botsForRoomPrompt(room, "@a、@C++。", false, bots).bots.map((bot) => bot.name)).toEqual(["A", "C++"]);
  });
  it("keeps the live room bounded and moves older turns to append-only history", () => {
    const bot = createBot({ name: "Alpha" });
    const room = createRoom({ members: [bot.id] });
    // Seed a full room in one write, then append past the cap.
    const path = join(root, "bots", "rooms", `${room.id}.json`);
    const seeded = { ...JSON.parse(readFileSync(path, "utf8")), messages: Array.from({ length: 500 }, (_, index) => ({ id: `seed-${index}`, role: "user", text: `発言 ${index}`, createdAt: index + 1 })) };
    writeFileSync(path, `${JSON.stringify(seeded)}\n`, "utf8");
    for (let index = 0; index < 3; index += 1) appendRoomMessage(room.id, { role: "user", text: `追加 ${index}` });

    const messages = getRoom(room.id)!.messages;
    expect(messages).toHaveLength(500);
    expect(messages[0].id).toBe("seed-3");
    expect(messages.at(-1)?.text).toBe("追加 2");
    const archived = readFileSync(join(root, "bots", "rooms", room.id, "history.jsonl"), "utf8").trim().split("\n");
    expect(archived.map((line) => JSON.parse(line).id)).toEqual(["seed-0", "seed-1", "seed-2"]);
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
  it("persists relay claims so replay remains blocked after a module reload", async () => {
    const [source, target] = ["Source", "Target"].map((name) => createBot({ name }));
    const room = createRoom({ members: [source.id, target.id] });
    patchRoom(room.id, { botRelayEnabled: true });
    const token = issueRoomRelayEnvelope(room.id, source.id, [target.id]);
    const envelope = consumeRoomRelayEnvelope(room.id, token!);
    expect(envelope).toBeDefined();
    const relayState = JSON.parse(readFileSync(join(root, "bots", "rooms", room.id, "relay.json"), "utf8")) as { claims: Record<string, string[]> };
    expect(relayState.claims[envelope!.turnId]).toEqual(expect.arrayContaining([source.id, target.id]));
    // A fresh module/worker reads the durable claim, rather than an in-process Map.
    vi.resetModules();
    const restartedRooms = await import("./rooms");
    expect(restartedRooms.consumeRoomRelayEnvelope(room.id, token!)).toBeUndefined();
    expect(restartedRooms.issueRoomRelayEnvelope(room.id, target.id, [source.id], token!)).toBeUndefined();
  });
  it("revalidates relay participants when a persisted envelope is consumed", () => {
    const [source, target] = ["Source", "Target"].map((name) => createBot({ name }));
    const room = createRoom({ members: [source.id, target.id] });
    patchRoom(room.id, { botRelayEnabled: true });
    const token = issueRoomRelayEnvelope(room.id, source.id, [target.id]);
    expect(token).toBeDefined();
    patchBot(target.id, { enabled: false });
    expect(consumeRoomRelayEnvelope(room.id, token!)).toBeUndefined();
    patchBot(target.id, { enabled: true });
    patchRoom(room.id, { members: [source.id] });
    expect(consumeRoomRelayEnvelope(room.id, token!)).toBeUndefined();
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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const testState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => testState.root }; });
import { createBot } from "./bots";
import { botsForRoomPrompt, createRoom, getRoom, patchRoom } from "./rooms";

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
  });
});

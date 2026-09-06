import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => botTestState.root }; });
import { createBot, deleteBot, getBot, listBots, patchBot } from "./bots";
import { BOT_AVATAR_COLORS, avatarColorForId } from "./bot-avatar";

describe("bot store", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-bots-")); botTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botTestState.root = ""; });
  it("creates the bot home and minimum config", () => {
    const bot = createBot({ name: "Researcher" });
    expect(listBots().map((item) => item.id)).toEqual([bot.id]);
    expect(readFileSync(join(root, "bots", bot.id, "SOUL.md"), "utf8")).toContain("ボットの役割");
    const config = JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8"));
    expect(config.skills.mode).toBe("inherit"); expect(config.enabled).toBe(true);
  });
  it("assigns a palette color and persists color patches", () => {
    const bot = createBot({ name: "Color bot" });
    expect(BOT_AVATAR_COLORS).toContain(bot.avatarColor);
    expect(JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8")).avatarColor).toBe(bot.avatarColor);
    expect(patchBot(bot.id, { avatarColor: "#123456" })?.avatarColor).toBe("#123456");
    expect(getBot(bot.id)?.avatarColor).toBe("#123456");
  });
  it("migrates a legacy config to a deterministic avatar color", () => {
    const bot = createBot({ name: "Legacy bot" });
    const configPath = join(root, "bots", bot.id, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.avatarColor;
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(getBot(bot.id)?.avatarColor).toBe(avatarColorForId(bot.id));
    expect(JSON.parse(readFileSync(configPath, "utf8")).avatarColor).toBe(avatarColorForId(bot.id));
  });
  it("patches SOUL and removes a bot", () => {
    const bot = createBot({ name: "A" });
    expect(patchBot(bot.id, { name: "B", soul: "Be precise" })?.name).toBe("B");
    expect(getBot(bot.id)?.soul).toBe("Be precise"); expect(deleteBot(bot.id)).toBe(true); expect(getBot(bot.id)).toBeUndefined();
  });
});

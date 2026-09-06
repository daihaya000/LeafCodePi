import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => botTestState.root }; });
import { createBot, deleteBot, getBot, listBots, patchBot } from "./bots";

describe("bot store", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-bots-")); botTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botTestState.root = ""; });
  it("creates the bot home and minimum config", () => {
    const bot = createBot({ name: "Researcher" });
    expect(listBots().map((item) => item.id)).toEqual([bot.id]);
    expect(readFileSync(join(root, "bots", bot.id, "SOUL.md"), "utf8")).toContain("Bot role");
    const config = JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8"));
    expect(config.skills.mode).toBe("inherit"); expect(config.enabled).toBe(true);
  });
  it("patches SOUL and removes a bot", () => {
    const bot = createBot({ name: "A" });
    expect(patchBot(bot.id, { name: "B", soul: "Be precise" })?.name).toBe("B");
    expect(getBot(bot.id)?.soul).toBe("Be precise"); expect(deleteBot(bot.id)).toBe(true); expect(getBot(bot.id)).toBeUndefined();
  });
});

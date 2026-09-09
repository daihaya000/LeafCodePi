import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => botTestState.root, storePath: () => join(botTestState.root, "store.json") }; });
import { botPromptSources, botRuntimeContext, botSoul, createBot, deleteBot, getBot, listBots, patchBot } from "./bots";
import { BOT_AVATAR_COLORS, avatarColorForId } from "./bot-avatar";
import type { BotDto } from "./types";

describe("bot runtime context", () => {
  it("identifies only loaded extensions and distinguishes dependencies from callable tools", () => {
    const context = botRuntimeContext([
      { path: join("repo", "extensions", "leafcode-subagents", "index.ts") },
      { path: join("agent", "extensions", "optional.ts") },
    ]);
    expect(context).toContain('"name":"leafcode-subagents"');
    expect(context).toContain('"requiredByLeafCode":true');
    expect(context).toContain('"name":"optional"');
    expect(context).toContain('"requiredByLeafCode":false');
    expect(context).toContain("tool_search");
    expect(context).toContain("available_skills");
    expect(context).toContain("Bot skill restrictions");
    expect(context).not.toContain("AGENTS.md");
    expect(botRuntimeContext([])).not.toContain('"name":');
  });
});

describe("bot store", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-bots-")); botTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botTestState.root = ""; });
  it("creates the bot home and minimum config", () => {
    const bot = createBot({ name: "Researcher" });
    expect(listBots().map((item) => item.id)).toEqual([bot.id]);
    expect(JSON.parse(readFileSync(join(root, "store.json"), "utf8")).tasks).toHaveLength(1);
    expect(readFileSync(join(root, "bots", bot.id, "SOUL.md"), "utf8")).toContain("ボットの役割");
    const config = JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8"));
    expect(config.skills.mode).toBe("inherit"); expect(config.enabled).toBe(true); expect(config.codeAutoApprove).toBe(true);
  });
  it("defaults missing Code approval to on while preserving an explicit off", () => {
    const bot = createBot({ name: "Approval bot" });
    const configPath = join(root, "bots", bot.id, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.codeAutoApprove;
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(getBot(bot.id)?.codeAutoApprove).toBe(true);
    patchBot(bot.id, { codeAutoApprove: false });
    expect(getBot(bot.id)?.codeAutoApprove).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8")).codeAutoApprove).toBe(false);
  });
  it("assigns a palette color and persists color patches", () => {
    const bot = createBot({ name: "Color bot" });
    expect(BOT_AVATAR_COLORS).toContain(bot.avatarColor);
    expect(JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8")).avatarColor).toBe(bot.avatarColor);
    expect(patchBot(bot.id, { avatarColor: "#123456" })?.avatarColor).toBe("#123456");
    expect(getBot(bot.id)?.avatarColor).toBe("#123456");
  });
  it("keeps legacy or invalid shapes circular and persists a selected shape", () => {
    const bot = createBot({ name: "Shape bot" });
    const configPath = join(root, "bots", bot.id, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const avatarShape of [undefined, "bad-shape", "__proto__"]) {
      fs.writeFileSync(configPath, JSON.stringify({ ...config, avatarShape }));
      expect(getBot(bot.id)?.avatarShape).toBe("circle");
    }
    patchBot(bot.id, { avatarShape: "droplet" });
    expect(getBot(bot.id)?.avatarShape).toBe("droplet");
    expect(JSON.parse(readFileSync(configPath, "utf8")).avatarShape).toBe("droplet");
  });
  it("persists eye color and accessories, clearing the eye color with null", () => {
    const bot = createBot({ name: "Face bot" });
    const configPath = join(root, "bots", bot.id, "config.json");
    expect(bot).toMatchObject({ avatarGlasses: false, avatarMustache: false });
    expect(bot.avatarEyeColor).toBeUndefined();
    expect(patchBot(bot.id, { avatarEyeColor: "#000000", avatarGlasses: true, avatarMustache: true })).toMatchObject({ avatarEyeColor: "#000000", avatarGlasses: true, avatarMustache: true });
    expect(getBot(bot.id)).toMatchObject({ avatarEyeColor: "#000000", avatarGlasses: true, avatarMustache: true });
    // Unrelated patches keep the face, and null resets the eye color to the automatic default.
    expect(patchBot(bot.id, { name: "Face bot 2" })?.avatarEyeColor).toBe("#000000");
    expect(patchBot(bot.id, { avatarEyeColor: null })?.avatarEyeColor).toBeUndefined();
    expect(getBot(bot.id)?.avatarEyeColor).toBeUndefined();
    expect("avatarEyeColor" in JSON.parse(readFileSync(configPath, "utf8"))).toBe(false);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, avatarEyeColor: "#EF4444", avatarGlasses: "yes" }));
    expect(getBot(bot.id)).toMatchObject({ avatarGlasses: false, avatarMustache: true });
    expect(getBot(bot.id)?.avatarEyeColor).toBeUndefined();
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
  it("persists notification preferences across reloads", () => {
    const bot = createBot({ name: "Notify bot" });
    expect(bot.notificationsEnabled).toBe(true);
    patchBot(bot.id, { notificationsEnabled: false });
    expect(getBot(bot.id)?.notificationsEnabled).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8")).notificationsEnabled).toBe(false);
  });
  it("persists per-bot skill rules and extra roots", () => {
    const bot = createBot({ name: "Config bot" });
    const updated = patchBot(bot.id, {
      skills: { mode: "include", include: ["review"], exclude: ["unsafe"] },
      extraRoots: ["C:\\shared", "/srv/shared"],
    });
    expect(updated?.skills).toEqual({ mode: "include", include: ["review"], exclude: ["unsafe"] });
    expect(getBot(bot.id)?.extraRoots).toEqual(["C:\\shared", "/srv/shared"]);
  });
  it("patches SOUL and removes a bot", () => {
    const bot = createBot({ name: "A" });
    expect(patchBot(bot.id, { name: "B", soul: "Be precise" })?.name).toBe("B");
    expect(getBot(bot.id)?.soul).toBe("Be precise"); expect(deleteBot(bot.id)).toBe(true); expect(getBot(bot.id)).toBeUndefined();
  });
  it("persists an editable profile label across reloads", () => {
    const bot = createBot({ name: "Profile bot" });
    patchBot(bot.id, { name: "Renamed bot", label: "調査アシスタント" });
    const reloaded = getBot(bot.id) as BotDto & { label: string };
    expect(reloaded.name).toBe("Renamed bot");
    expect(reloaded.label).toBe("調査アシスタント");
    expect(JSON.parse(readFileSync(join(root, "bots", bot.id, "config.json"), "utf8")).label).toBe("調査アシスタント");
  });
  it("starts with no avatar image and persists/clears an uploaded one", () => {
    const bot = createBot({ name: "Image bot" });
    expect(bot.avatarImage).toBeNull();
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    expect(patchBot(bot.id, { avatarImage: dataUrl })?.avatarImage).toBe(dataUrl);
    expect(getBot(bot.id)?.avatarImage).toBe(dataUrl);
    expect(patchBot(bot.id, { avatarImage: null })?.avatarImage).toBeNull();
    expect(getBot(bot.id)?.avatarImage).toBeNull();
  });
  it("builds the bot prompt from BOTS.md and SOUL.md, ignoring the global AGENTS.md", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-agent-"));
    fs.writeFileSync(join(agentDir, "AGENTS.md"), "# Global rule\nNever ignore this.");
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const bot = createBot({ name: "Isolated bot" });
      // No BOTS.md yet: SOUL.md alone drives the bot.
      expect(botPromptSources(bot.id)).toEqual([join(root, "bots", bot.id, "SOUL.md")]);
      expect(botSoul(bot.id)).toContain("ボットの役割");

      fs.writeFileSync(join(agentDir, "BOTS.md"), "# Shared\nAlways answer in Japanese.");
      const sources = botPromptSources(bot.id);
      expect(sources).toEqual([
        join(agentDir, "BOTS.md"),
        join(root, "bots", bot.id, "SOUL.md"),
      ]);
      expect(sources.some((path) => path.endsWith("AGENTS.md"))).toBe(false);
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
  it("drops an invalid persisted avatar image on read", () => {
    const bot = createBot({ name: "Bad image bot" });
    const configPath = join(root, "bots", bot.id, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.avatarImage = "not-a-data-url";
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(getBot(bot.id)?.avatarImage).toBeNull();
  });
});

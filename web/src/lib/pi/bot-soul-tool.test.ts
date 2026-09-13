import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot } from "@/lib/bots";
import { BOT_SOUL_MAX_BYTES, botSoulTool } from "./bot-soul-tool";

const botTestState = vi.hoisted(() => ({ root: "" }));

// Keep the bot store isolated without changing the production data directory.
vi.mock("@/lib/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/paths")>();
  return {
    ...actual,
    dataDir: () => botTestState.root,
    storePath: () => join(botTestState.root, "store.json"),
  };
});

describe("bot soul tool", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-bot-soul-tool-"));
    botTestState.root = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    botTestState.root = "";
  });

  it("updates only the Bot's own SOUL.md and requests a session reload", async () => {
    const bot = createBot({ name: "Soul bot" });
    const other = createBot({ name: "Other bot" });
    const otherSoul = readFileSync(join(root, "bots", other.id, "SOUL.md"), "utf8");
    let updated = false;
    let registered: unknown;
    botSoulTool(bot.id, () => { updated = true; })({
      registerTool(tool: unknown) { registered = tool; },
    } as unknown as ExtensionAPI);

    const tool = registered as {
      execute: (...args: unknown[]) => Promise<{ details: { updated: boolean } }>;
    };
    const content = "# Updated role\n\nBe concise.";
    const result = await tool.execute("call", { content }, undefined, undefined, {});

    expect(result.details).toEqual({ updated: true });
    expect(updated).toBe(true);
    expect(readFileSync(join(root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(content);
    expect(readFileSync(join(root, "bots", other.id, "SOUL.md"), "utf8")).toBe(otherSoul);
  });

  it("rejects an oversized replacement before writing", async () => {
    const bot = createBot({ name: "Size bot" });
    let registered: unknown;
    botSoulTool(bot.id)({
      registerTool(tool: unknown) { registered = tool; },
    } as unknown as ExtensionAPI);
    const tool = registered as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const original = readFileSync(join(root, "bots", bot.id, "SOUL.md"), "utf8");

    await expect(tool.execute("call", {
      content: "x".repeat(BOT_SOUL_MAX_BYTES + 1),
    }, undefined, undefined, {})).rejects.toThrow("too large");
    expect(readFileSync(join(root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(original);
  });
});

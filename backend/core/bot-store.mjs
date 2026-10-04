import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBotConfig } from "./bot-config.mjs";

/**
 * Bot files on disk: one directory per bot holding config.json, SOUL.md,
 * MEMORY.md and workspace/. The root is resolved per call (it follows the data
 * directory) and the tool vocabulary is injected for config normalization, so
 * this store keeps no process-local state.
 */
export class BotFileStore {
  constructor({ botsRoot, toolNames, defaultToolNames }) {
    this.botsRoot = botsRoot;
    this.toolNames = toolNames;
    this.defaultToolNames = defaultToolNames;
  }

  assertId(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) throw new Error("invalid bot id");
  }

  botRoot(id) {
    this.assertId(id);
    return join(this.botsRoot(), id);
  }

  configPath(id) { return join(this.botRoot(id), "config.json"); }
  soulPath(id) { return join(this.botRoot(id), "SOUL.md"); }
  memoryPath(id) { return join(this.botRoot(id), "MEMORY.md"); }
  workspacePath(id) { return join(this.botRoot(id), "workspace"); }

  /**
   * Replace a file atomically (temp + rename), so a crash never leaves a half-written
   * file. A failed write removes its own temporary file: repeated failures must not pile
   * up `*.tmp` files that sync tools and antivirus then hold open, making the next rename fail.
   */
  #writeTextAtomic(target, text) {
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, text, "utf8");
      renameSync(temporary, target);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  writeConfig(config) {
    mkdirSync(this.botRoot(config.id), { recursive: true });
    this.#writeTextAtomic(this.configPath(config.id), `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Null for a missing, unreadable, malformed or mismatched config. */
  readConfig(id) {
    return parseBotConfig({
      id,
      readText: () => readFileSync(this.configPath(id), "utf8"),
      writeConfig: (config) => this.writeConfig(config),
      toolNames: this.toolNames,
      defaultToolNames: this.defaultToolNames,
    });
  }

  /** Every valid config, most recently updated first. Directories without one are skipped. */
  listConfigs() {
    const root = this.botsRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readConfig(entry.name))
      .filter((config) => Boolean(config))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  readSoulText(id) { return readFileSync(this.soulPath(id), "utf8"); }
  /** SOUL.md goes verbatim into the prompt, so it is never left half-written. */
  writeSoul(id, text) { this.#writeTextAtomic(this.soulPath(id), text); }

  ensureMemoryFile(id) {
    // Exclusive create: a concurrent writer that got there first keeps its memory.
    try { writeFileSync(this.memoryPath(id), "# Bot memory\n\n", { encoding: "utf8", flag: "wx" }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }

  /** `mtime:size` of SOUL.md, or null when it cannot be read (deleted or unreadable). */
  soulRevision(id) {
    try {
      const stat = statSync(this.soulPath(id));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  /** Removes the bot directory including MEMORY.md and the workspace. */
  removeBot(id) {
    rmSync(this.botRoot(id), { recursive: true, force: true });
  }
}

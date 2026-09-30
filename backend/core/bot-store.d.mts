import type { BotConfig } from "./bot-config.mjs";

export class BotFileStore {
  constructor(options: {
    botsRoot: () => string;
    toolNames: readonly string[];
    defaultToolNames: readonly string[];
  });
  assertId(id: string): void;
  botRoot(id: string): string;
  configPath(id: string): string;
  soulPath(id: string): string;
  memoryPath(id: string): string;
  workspacePath(id: string): string;
  writeConfig(config: BotConfig): void;
  readConfig(id: string): BotConfig | null;
  listConfigs(): BotConfig[];
  readSoulText(id: string): string;
  writeSoul(id: string, text: string): void;
  ensureMemoryFile(id: string): void;
  soulRevision(id: string): string | null;
  removeBot(id: string): void;
}

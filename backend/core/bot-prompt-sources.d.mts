export type BotPromptSourceDeps = {
  /** Creates MEMORY.md when missing, so the Bot has a place to record facts. */
  ensureMemoryFile: (id: string) => void;
  sharedBotsMdPath: () => string;
  globalUserMdPath: () => string;
  soulPath: (id: string) => string;
  memoryPath: (id: string) => string;
  exists: (path: string) => boolean;
};

export function botPromptSources(id: string, deps: BotPromptSourceDeps): string[];

import type { BotConfig, BotPermissionMode } from "./bot-config.mjs";
import type { BotConfigPatch } from "./bot-crud.mjs";
import type { ThinkingLevel } from "@shared/types";

/** The bot file store surface this module needs. */
export type BotLifecycleStore = {
  workspacePath: (id: string) => string;
  writeSoul: (id: string, text: string) => void;
  ensureMemoryFile: (id: string) => void;
  writeConfig: (config: BotConfig) => void;
  readConfig: (id: string) => BotConfig | null;
  removeBot: (id: string) => void;
};

/** The task records a Bot owns. */
export type BotLifecycleTask = { id: string; botId?: string | null; supervisorBotId?: string | null };

export type BotLifecycleDeps<Dto> = {
  store: BotLifecycleStore;
  tasks: {
    insertBotTask: (input: {
      id: string; botId: string; name: string; directory: string;
      model: string | null; thinkingLevel: ThinkingLevel | null; permissionMode: BotPermissionMode;
    }) => unknown;
    patchTask: (id: string, patch: { title?: string; thinkingLevel?: ThinkingLevel; permissionMode?: BotPermissionMode; supervisorBotId?: null }) => unknown;
    deleteTask: (id: string) => unknown;
    listTasks: (includeArchived: boolean, kind: "all") => BotLifecycleTask[];
  };
  defaultToolNames: readonly string[];
  soulTemplate: string;
  ensureWorkspace: (directory: string) => void;
  toDto: (config: BotConfig) => Dto;
  uuid: () => string;
  now: () => string;
};

export function createBotWithEffects<Dto>(
  input: { name?: string | null; model?: string | null; thinkingLevel?: ThinkingLevel | null; permissionMode?: BotPermissionMode | null },
  deps: BotLifecycleDeps<Dto>,
): Dto;

export function patchBotWithEffects<Dto>(
  id: string,
  patch: BotConfigPatch,
  deps: BotLifecycleDeps<Dto>,
): Dto | undefined;

export function deleteBotWithEffects(id: string, deps: BotLifecycleDeps<unknown>): boolean;

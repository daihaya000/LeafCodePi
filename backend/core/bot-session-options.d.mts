export type BotSessionOptions = {
  appendSystemPrompt: string[];
  noContextFiles: true;
  botSkills: unknown;
  botTools: string[];
  skillScope: "bot";
};

/**
 * Options for a Bot session, or null when this is not a Bot task (nothing to spread).
 * `platform` decides whether the powershell tool survives.
 */
export function resolveBotSessionOptions(input: {
  isBot: boolean;
  promptSources: string[];
  roomOrigin: boolean;
  roomSystemPrompt: string;
  skills: unknown;
  tools: readonly string[] | undefined;
  defaultToolNames: readonly string[];
  platform: string;
}): BotSessionOptions | null;

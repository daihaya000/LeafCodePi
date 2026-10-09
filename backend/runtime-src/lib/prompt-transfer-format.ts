export const MAX_PROMPT_BACKUP_BYTES = 20 * 1024 * 1024;

export const PROMPT_FILE_GROUPS = {
  "共通": ["USER.md"],
  Code: ["SOUL.md", "AGENTS.md", "WORKFLOW.md", "TOOLS.md", "DESIGN.md"],
  Bot: ["BOTS.md"],
} as const;

export const PROMPT_FILE_NAMES = Object.values(PROMPT_FILE_GROUPS).flat() as Array<
  "USER.md" | "SOUL.md" | "AGENTS.md" | "WORKFLOW.md" | "TOOLS.md" | "DESIGN.md" | "BOTS.md"
>;
export type PromptFileName = (typeof PROMPT_FILE_NAMES)[number];

export type PromptBackup = {
  format: "leafcode-pi-prompts";
  version: 1;
  exportedAt: string;
  files: Partial<Record<PromptFileName, string>>;
};

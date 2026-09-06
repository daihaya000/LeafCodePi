import type { ThinkingLevel } from "@/lib/types";

export const BOT_DEFAULT_PERMISSION_KEY = "bot-default-permission";
export const BOT_DEFAULT_THINKING_KEY = "bot-default-thinking";
export const BOT_DEFAULT_PERMISSION_VALUES = ["allow", "ask", "deny"] as const;
export const BOT_DEFAULT_THINKING_VALUES: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type BotDefaultPermission = (typeof BOT_DEFAULT_PERMISSION_VALUES)[number];

export function parseBotDefaultPermission(value: string | null): BotDefaultPermission {
  return BOT_DEFAULT_PERMISSION_VALUES.includes(value as BotDefaultPermission) ? value as BotDefaultPermission : "ask";
}

export function parseBotDefaultThinking(value: string | null): ThinkingLevel {
  return BOT_DEFAULT_THINKING_VALUES.includes(value as ThinkingLevel) ? value as ThinkingLevel : "off";
}

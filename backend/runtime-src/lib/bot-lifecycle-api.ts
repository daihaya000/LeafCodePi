import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { botsWithCodeSessionCounts } from "@backend-core/bot-session-counts.mjs";
import { createBot, getBot, isBotNameWithinSize, listBots, patchBot } from "./bots";
import { botTemplateById } from "@shared/bot-marketplace";
import { getSetting } from "./pi/web-settings";
import { setBotTools } from "./pi/harness";
import { listTasks } from "./store";
import { parseBotDefaultPermission, parseBotDefaultThinking, BOT_DEFAULT_PERMISSION_KEY, BOT_DEFAULT_THINKING_KEY } from "./bot-settings";
import type { BotAdminResult } from "./bot-admin";

/** Counts include only working Code and prefer botId over supervisorBotId. */
export function readBotCollection() {
  assertConfigurationOwner();
  return { bots: botsWithCodeSessionCounts(listBots(), listTasks()) };
}
export function readBotConfiguration(id: string): BotAdminResult {
  assertConfigurationOwner();
  const bot = getBot(id);
  if (!bot) return { status: 404, body: { error: "ボットが見つかりません" } };
  // Refresh only already-live tools after legacy migration; never hydrate a cold conversation.
  setBotTools(bot.id, bot.tools ?? []);
  return { status: 200, body: { bot } };
}
export function createBotConfiguration(parsed: unknown): BotAdminResult {
  assertConfigurationOwner();
  const body = parsed as { name?: unknown; templateId?: unknown } | null;
  if (body?.name !== undefined && (typeof body.name !== "string" || !isBotNameWithinSize(body.name))) return { status: 400, body: { error: "invalid name" } };
  if (body?.templateId !== undefined && typeof body.templateId !== "string") return { status: 400, body: { error: "invalid template" } };
  const template = typeof body?.templateId === "string" ? botTemplateById(body.templateId) : undefined;
  if (body?.templateId !== undefined && !template) return { status: 400, body: { error: "unknown template" } };
  const created = createBot({ name: (body?.name as string | undefined) ?? template?.name, permissionMode: parseBotDefaultPermission(getSetting(BOT_DEFAULT_PERMISSION_KEY)), thinkingLevel: parseBotDefaultThinking(getSetting(BOT_DEFAULT_THINKING_KEY)) });
  const bot = template ? patchBot(created.id, { label: template.label, soul: template.soul }) ?? created : created;
  return { status: 201, body: { bot } };
}

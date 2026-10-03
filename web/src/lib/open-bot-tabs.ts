/**
 * Bots whose conversation tab is open anywhere in the split layout.
 *
 * The routine notifier suppresses its own sound/notification for a Bot that the
 * user can already see, because BotView renders the inline card. With a split
 * layout the pathname only names the active pane, so a background Bot pane would
 * still get a duplicate notification. Tab owners publish their Bot ids here.
 */

let openBotTabIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeOpenBotTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOpenBotTabIds(): ReadonlySet<string> {
  return openBotTabIds;
}

/** Publish the Bot ids currently open in any pane. */
export function setOpenBotTabIds(botIds: Iterable<string>): void {
  const next = new Set(botIds);
  if (next.size === openBotTabIds.size && [...next].every((id) => openBotTabIds.has(id))) return;
  openBotTabIds = next;
  emit();
}

/** True when the Bot's conversation is open in the active pane or a split pane. */
export function isBotTabOpen(botId: string): boolean {
  return Boolean(botId) && openBotTabIds.has(botId);
}
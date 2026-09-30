/**
 * How many Code sessions each Bot is running right now.
 *
 * A task counts for the Bot it belongs to (`botId`) or, for a Code task a Bot supervises, its
 * supervisor. Only `working` tasks count: a queued or finished one is not a running session. The
 * rule lives here so the Web route and the Backend's relay compute the same number.
 */
export function botCodeSessionCounts(tasks) {
  const counts = {};
  for (const task of tasks ?? []) {
    if (task?.status !== "working") continue;
    const botId = task.botId ?? task.supervisorBotId;
    if (!botId) continue;
    counts[botId] = (counts[botId] ?? 0) + 1;
  }
  return counts;
}

/** The Bot DTOs with their running-session count attached. */
export function botsWithCodeSessionCounts(bots, tasks) {
  const counts = botCodeSessionCounts(tasks);
  return (bots ?? []).map((bot) => ({ ...bot, codeSessionCount: counts[bot?.id] ?? 0 }));
}

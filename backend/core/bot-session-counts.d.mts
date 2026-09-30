/** Running Code session count per Bot id. */
export function botCodeSessionCounts(
  tasks: ReadonlyArray<{ status?: string; botId?: string | null; supervisorBotId?: string | null }> | null | undefined,
): Record<string, number>;

/** The Bot DTOs with `codeSessionCount` attached (0 when the Bot is idle). */
export function botsWithCodeSessionCounts<T extends { id?: string }>(
  bots: readonly T[] | null | undefined,
  tasks: ReadonlyArray<{ status?: string; botId?: string | null; supervisorBotId?: string | null }> | null | undefined,
): Array<T & { codeSessionCount: number }>;

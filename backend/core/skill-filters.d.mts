/** Skills disabled per scope, as stored in the skills-state file. */
export type SkillsStateLike = Record<string, Record<string, boolean>>;

/** A Bot's per-session skill allowlist. */
export type BotSkillsLike = {
  mode: string;
  include: readonly string[];
  exclude: readonly string[];
};

/** Drop the skills disabled in `scope`; an empty scope state returns a copy. */
export function filterSkillsByState<T extends { name: string }>(
  skills: readonly T[],
  state: SkillsStateLike,
  scope: string,
): T[];

/** Apply a Bot's inherit/include/exclude allowlist. */
export function filterSkillsForBot<T extends { name: string }>(
  skills: readonly T[],
  config: BotSkillsLike,
): T[];
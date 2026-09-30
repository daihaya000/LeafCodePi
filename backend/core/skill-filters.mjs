/**
 * Skill filtering for a session's resource loader. Pure: the caller supplies the
 * skills-state file contents and the Bot's allowlist.
 */

/**
 * Drop the skills disabled in this scope. An empty state for the scope returns the
 * input unchanged (as a copy), so the common case costs nothing.
 */
export function filterSkillsByState(skills, state, scope) {
  if (Object.keys(state[scope]).length === 0) return [...skills];
  return skills.filter((skill) => state[scope][skill.name] !== true);
}

/** Apply a Bot's per-session inherit/include/exclude allowlist. */
export function filterSkillsForBot(skills, config) {
  if (config.mode === "include") {
    const allowed = new Set(config.include);
    return skills.filter((skill) => allowed.has(skill.name));
  }
  if (config.mode === "exclude") {
    const excluded = new Set(config.exclude);
    return skills.filter((skill) => !excluded.has(skill.name));
  }
  return [...skills];
}
/**
 * Prompt source files for a Bot session, in the order Pi reads them: the shared
 * BOTS.md and USER.md when they exist, then the Bot's own SOUL.md, then its
 * MEMORY.md when it exists. Nothing global like AGENTS.md is included: a Bot's
 * instructions come from BOTS.md/USER.md/SOUL.md/MEMORY.md only.
 *
 * Paths, existence checks and MEMORY initialization are injected, and paths are
 * returned (not contents) so `session.reload()` re-reads edits without a new session.
 */
export function botPromptSources(id, deps) {
  deps.ensureMemoryFile(id);
  const sources = [];
  const shared = deps.sharedBotsMdPath();
  if (deps.exists(shared)) sources.push(shared);
  const user = deps.globalUserMdPath();
  if (deps.exists(user)) sources.push(user);
  // SOUL.md is always a source, even before it is written: the session loader
  // creates the default template when the file is missing.
  sources.push(deps.soulPath(id));
  const memory = deps.memoryPath(id);
  if (deps.exists(memory)) sources.push(memory);
  return sources;
}

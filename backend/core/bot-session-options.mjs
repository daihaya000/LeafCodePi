/**
 * SDK options for a Bot session. Only Bot tasks get them; anything else returns null
 * so the caller spreads nothing.
 *
 * The appended system prompt keeps its sources in order and appends the Room prompt
 * only when the task was started from a Room. Context files are always off for a Bot
 * (its identity comes from the prompt sources). `powershell` is dropped on platforms
 * that do not have it; everything else is passed through as configured, and an unset
 * tool list falls back to the defaults.
 */
export function resolveBotSessionOptions({
  isBot,
  promptSources,
  roomOrigin,
  roomSystemPrompt,
  skills,
  tools,
  defaultToolNames,
  platform,
}) {
  if (isBot !== true) return null;
  return {
    appendSystemPrompt: [...promptSources, ...(roomOrigin === true ? [roomSystemPrompt] : [])],
    noContextFiles: true,
    botSkills: skills,
    botTools: (tools ?? defaultToolNames).filter((tool) => tool !== "powershell" || platform === "win32"),
    skillScope: "bot",
  };
}

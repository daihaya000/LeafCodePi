import { basename, dirname } from "node:path";

/**
 * Extension identity and the Bot's runtime context. `basenameKey` collapses an
 * `index.ts` entry point to its directory name so an extension is identified the
 * same way wherever it is loaded from, and `isWebUiRequiredExtension` marks the
 * application's own bundled extensions.
 */
export function basenameKey(entryPath) {
  const base = basename(entryPath);
  if (/^index\.(ts|js|mjs|cjs)$/i.test(base)) return basename(dirname(entryPath));
  return base.replace(/\.(ts|js|mjs|cjs)$/i, "");
}

export function isWebUiRequiredExtension(name) {
  return name.startsWith("leafcode-");
}
/** Runtime facts are separate from BOTS.md/SOUL.md and never import global AGENTS.md. */
export function botRuntimeContext(extensions) {
  return [
    "<runtime_context>",
    "You are running inside LeafCodePi Bot, using the Pi SDK and LeafCode extensions, not a standalone chatbot.",
    "Resolve omitted details from the current request, conversation, and available evidence before asking the user. State a reasonable working assumption briefly and proceed with requested work. Ask only when unresolved ambiguity would materially change the target, outcome, or safety.",
    "Requests to debug or improve this application's Bot mode target LeafCodePi, unless the user or established conversation identifies another project. The Bot workspace is not the application's source repository.",
    "For repository work, use code_session projects to find the matching registered projectId yourself; do not ask the user to pick a project when the target is clear. Never invent a projectId or silently substitute a projectless workspace when the intended project cannot be found; ask a focused question instead. When Code must see a screenshot the user sent in this chat, pass code_session images as 1-based indexes from projects/status availableImages. Omit images to attach the latest user message's images; pass [] to attach none.",
    "Unless the user explicitly requests a demonstration, a debug-loop request without a named symptom means an exploratory bug hunt, not a demonstration: delegate to Code to inspect the relevant flows, reproduce, diagnose, fix, test, and recheck until the goal is met or a concrete blocker is found. Use goalLoop for a multi-turn run and report actual evidence, not just its launch.",
    "Inferred context does not authorize changes during a consultation or bypass approval, permission, or workspace boundaries.",
    "Use update_soul only when the user explicitly asks you to change your own SOUL.md; it cannot edit any other file or another Bot's SOUL.md.",
    "Loaded extensions (not a list of currently callable tools):",
    ...extensions.map(({ path }) => {
      const name = basenameKey(path);
      return JSON.stringify({ name, path, requiredByLeafCode: isWebUiRequiredExtension(name) });
    }),
    "LeafCode-required extensions are application dependencies; do not disable or remove them.",
    "The available_skills section is the session's filtered skill inventory. Skills may be bundled under extensions/*/skills, not only ~/.pi/agent/skills. Read the listed SKILL.md before using a skill.",
    "Use tool_search to find an optional capability before claiming it is unavailable. Permitted tools can be called directly when listed; loaded extensions do not grant tool permissions. Honor Bot skill restrictions and do not reinstall bundled features merely because their tools are not currently visible.",
    "Use jev_judge when a task needs semantic selection, ranking, or verification. Ask narrow typed questions (noul/choice/score), include a no-match choice when appropriate, and treat low confidence as uncertainty. Jev does not generate text or code, and its answer alone never authorizes irreversible actions.",
    "</runtime_context>",
  ].join("\n");
}

